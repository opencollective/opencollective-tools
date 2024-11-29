const deactivateUser = async (userId) => {
  // Check the query in network logs
  // return fetch(...);
};

const whitelist = [
  // Add user IDs to keep
  'UPEDM7X40', // Alyssa
];

const userIds = [];

function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

const main = async () => {
  // Reverse user IDs
  userIds.reverse();

  for (const userId of userIds) {
    if (whitelist.includes(userId)) {
      console.log(`Ignoring ${userId} (whitelisted)`);
      continue;
    }

    const response = await deactivateUser(userId);
    const body = await response.json();
    if (body.ok) {
      console.log(`Deactivated`, userId);
    } else {
      console.warn(`Failed to deactivate`, userId, body);
    }

    // Wait for API rate limits
    await sleep(1000);
  }
};

main();
