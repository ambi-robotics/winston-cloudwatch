describe("utils", function () {
  const assert = require("node:assert/strict");

  describe("stringify", function () {
    const lib = require("../lib/utils");

    it("stringifies an object", function () {
      const object = { answer: 42 };
      assert.strictEqual(
        lib.stringify(object),
        JSON.stringify(object, null, "  ")
      );
    });

    it("stringifies an Error instance", function () {
      const error = new Error("uh-oh"),
        result = JSON.parse(lib.stringify(error));
      assert.strictEqual(result.message, "uh-oh");
      assert.ok(
        typeof result.stack === "string",
        `Expected result.stack to be a string`
      );
    });

    it("handles circular objects", function () {
      const circular = {};
      const child = { circular };
      circular.child = child;

      assert.doesNotThrow(() => {
        lib.stringify(circular);
      });
    });
  });
});
