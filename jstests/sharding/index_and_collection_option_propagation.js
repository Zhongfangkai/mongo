/**
 * Mongos has special targeting behavior for createIndex, reIndex, dropIndex, and collMod:
 *
 * - If called on an unsharded collection, the request is routed only to the primary shard.
 * - If called on a sharded collection, the request is broadcast to all shards, but
 *   NamespaceNotFound and CannotImplicitlyCreateCollection errors do not lead to command failure
 *   (though these errors are reported in the 'raw' shard responses).
 *
 * This test verifies this behavior.
 */
(function() {
    // Helper function that runs listIndexes against shards to check for the existence of an index.
    function checkShardIndexes(indexKey, shardsWithIndex, shardsWithoutIndex) {
        function shardHasIndex(indexKey, shard) {
            const res = shard.getDB(dbName).runCommand({listIndexes: collName});
            if (res.code === ErrorCodes.NamespaceNotFound) {
                return [res, false];
            }
            assert.commandWorked(res);
            for (index of res.cursor.firstBatch) {
                if (index.key.hasOwnProperty(indexKey)) {
                    return [res, true];
                }
            }
            return [res, false];
        }

        for (shard of shardsWithIndex) {
            [listIndexesRes, foundIndex] = shardHasIndex(indexKey, shard);
            assert(foundIndex,
                   "expected to see index with key " + indexKey + " in listIndexes response from " +
                       shard + ": " + tojson(listIndexesRes));
        }

        for (shard of shardsWithoutIndex) {
            [listIndexesRes, foundIndex] = shardHasIndex(indexKey, shard);
            assert(!foundIndex,
                   "expected not to see index with key " + indexKey +
                       " in listIndexes response from " + shard + ": " + tojson(listIndexesRes));
        }
    }

    // Helper function that runs listCollections against shards to check for the existence of a
    // collection option.
    function checkShardCollOption(optionKey, optionValue, shardsWithOption, shardsWithoutOption) {
        function shardHasOption(optionKey, optionValue, shard) {
            const res =
                shard.getDB(dbName).runCommand({listCollections: 1, filter: {name: collName}});
            assert.commandWorked(res);
            if (res.cursor.firstBatch.length === 0) {
                return [res, false];
            }
            assert.eq(1, res.cursor.firstBatch.length);
            if (friendlyEqual(res.cursor.firstBatch[0].options[optionKey], optionValue)) {
                return [res, true];
            }
            return [res, false];
        }

        for (shard of shardsWithOption) {
            [listCollsRes, foundOption] = shardHasOption(optionKey, optionValue, shard);
            assert(foundOption,
                   "expected to see option " + optionKey + " in listCollections response from " +
                       shard + ": " + tojson(listCollsRes));
        }

        for (shard of shardsWithoutOption) {
            [listOptionsRes, foundOption] = shardHasOption(optionKey, optionValue, shard);
            assert(!foundOption,
                   "expected not to see option " + optionKey +
                       " in listCollections response from " + shard + ": " + tojson(listCollsRes));
        }
    }

    const dbName = "test";
    const collName = "foo";
    const ns = dbName + "." + collName;

    var st = new ShardingTest(
        {shards: {rs0: {nodes: 1}, rs1: {nodes: 1}, rs2: {nodes: 1}}, other: {config: 3}});

    assert.commandWorked(st.s.adminCommand({enableSharding: dbName}));
    st.ensurePrimaryShard(dbName, st.shard0.name);

    // When creating index or setting a collection option on an unsharded collection, only the
    // primary shard is affected.

    assert.commandWorked(st.s.getDB(dbName).getCollection(collName).createIndex({"idx1": 1}));
    checkShardIndexes("idx1", [st.shard0], [st.shard1, st.shard2]);

    const validationOption1 = {dummyField1: {$type: "string"}};
    assert.commandWorked(st.s.getDB(dbName).runCommand({
        collMod: collName,
        validator: validationOption1,
        validationLevel: "moderate",
        validationAction: "warn"
    }));
    checkShardCollOption("validator", validationOption1, [st.shard0], [st.shard1, st.shard2]);

    // After sharding the collection but before any migrations, only the primary shard has the
    // index and collection option.
    assert.commandWorked(st.s.adminCommand({shardCollection: ns, key: {x: 1}}));
    checkShardIndexes("idx1", [st.shard0], [st.shard1, st.shard2]);
    checkShardCollOption("validator", validationOption1, [st.shard0], [st.shard1, st.shard2]);

    // After a migration, only shards that own data for the collection have the index and collection
    // option.
    assert.commandWorked(st.s.adminCommand({moveChunk: ns, find: {x: 0}, to: st.shard1.shardName}));
    checkShardIndexes("idx1", [st.shard0, st.shard1], [st.shard2]);
    checkShardCollOption("validator", validationOption1, [st.shard0, st.shard1], [st.shard2]);

    // Though some shards don't own data for the sharded collection, createIndex, reIndex,
    // dropIndex, and collMod (which are broadcast to all shards) report overall success (that is,
    // NamespaceNotFound-type errors from shards are ignored, though they are included in the 'raw'
    // shard responses).

    var res;

    // createIndex
    res = st.s.getDB(dbName).getCollection(collName).createIndex({"idx2": 1});
    assert.commandWorked(res);
    assert.eq(res.raw[st.shard0.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard1.host].ok, 1, tojson(res));
    assert.eq(
        res.raw[st.shard2.host].code, ErrorCodes.CannotImplicitlyCreateCollection, tojson(res));
    checkShardIndexes("idx2", [st.shard0, st.shard1], [st.shard2]);

    // reIndex
    res = st.s.getDB(dbName).getCollection(collName).reIndex();
    assert.commandWorked(res);
    assert.eq(res.raw[st.shard0.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard1.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard2.host].code, ErrorCodes.NamespaceNotFound, tojson(res));
    checkShardIndexes("idx1", [st.shard0, st.shard1], [st.shard2]);
    checkShardIndexes("idx2", [st.shard0, st.shard1], [st.shard2]);

    // dropIndex
    res = st.s.getDB(dbName).getCollection(collName).dropIndex("idx1_1");
    assert.commandWorked(res);
    assert.eq(res.raw[st.shard0.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard1.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard2.host].code, ErrorCodes.NamespaceNotFound, tojson(res));
    checkShardIndexes("idx1", [], [st.shard0, st.shard1, st.shard2]);

    // collMod
    const validationOption2 = {dummyField2: {$type: "string"}};
    res = st.s.getDB(dbName).runCommand({
        collMod: collName,
        validator: validationOption2,
        validationLevel: "moderate",
        validationAction: "warn"
    });
    assert.commandWorked(res);
    assert.eq(res.raw[st.shard0.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard1.host].ok, 1, tojson(res));
    assert.eq(res.raw[st.shard2.host].code, ErrorCodes.NamespaceNotFound, tojson(res));
    checkShardCollOption("validator", validationOption2, [st.shard0, st.shard1], [st.shard2]);

    st.stop();
})();
