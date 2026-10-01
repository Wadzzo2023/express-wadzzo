import { pLimit } from "./limit";

async function runTests() {
  console.log("Running pLimit tests...");

  // Test 1: Concurrency limit is respected
  const limit = pLimit(2);
  let active = 0;
  let maxActive = 0;

  const task = async (id: number) => {
    return limit(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return id;
    });
  };

  const results = await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
  if (results.join(",") !== "1,2,3,4,5") {
    throw new Error(`Unexpected results: ${results.join(",")}`);
  }
  if (maxActive > 2) {
    throw new Error(`Max concurrent exceeded: ${maxActive} > 2`);
  }
  console.log("✓ Concurrency limit respected (maxActive =", maxActive, ")");

  // Test 2: Error handling continues queue
  let caught = false;
  try {
    await limit(async () => {
      throw new Error("Task failed");
    });
  } catch {
    caught = true;
  }
  if (!caught) {
    throw new Error("Expected task to fail");
  }

  const afterError = await limit(async () => "recovered");
  if (afterError !== "recovered") {
    throw new Error("Expected recovery after failed task");
  }
  console.log("✓ Error handling and queue recovery verified");

  console.log("All limit tests passed successfully!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
