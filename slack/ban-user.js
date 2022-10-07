require('../env');

const { Command } = require('commander');
const { App } = require('@slack/bolt');
const { truncate } = require('lodash');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
} else if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error('Missing environment variable: SLACK_SIGNING_SECRET');
} else if (!process.env.SLACK_USER_TOKEN) {
  throw new Error('Missing environment variable: SLACK_USER_TOKEN');
}

const getSlackApp = () => {
  return new App({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    token: process.env.SLACK_BOT_TOKEN,
  });
};

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  program.argument('<id>', 'User ID of the member to ban');
  program.option('--run', 'Trigger actual ban');
  program.parse(argv);
  return program;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slackApp = getSlackApp();
  const bannedUserId = program.args[0];

  // Get banned user's details
  const { user } = await slackApp.client.users.info({ user: bannedUserId });
  console.log(`Banning user ${user.name} (${user.real_name})...`);

  // Use the search API to get all messages from user
  const { messages, files } = await slackApp.client.search.all({
    query: `from:${user.name}`,
    sort: 'timestamp',
    sort_dir: 'desc',
    token: process.env.SLACK_USER_TOKEN,
    count: 1000,
  });

  // Delete all files from user
  for (const file of files.matches) {
    // Double check that file is from the banned user
    if (file.user === bannedUserId) {
      console.log(`Deleting file ${file.name} from channels ${file.channels}`);
      if (options.run) {
        try {
          await slackApp.client.files.delete({ file: file.id });
        } catch (e) {
          // File eventually returns already deleted files, ignore them
          if (e.data.error === 'file_not_found') {
            continue;
          } else if (e.data.error === 'cant_delete_file') {
            console.log(`Skipping file ${file.name} because it can't be deleted`);
            continue;
          } else {
            throw e;
          }
        }
      }
    }
  }

  // Delete all messages from user
  for (const message of messages.matches) {
    // Double check that message is from the banned user
    if (message.user === bannedUserId) {
      console.log(`Deleting message from channel #${message.channel.name}: ${truncate(message.text, { length: 100 })}`);
      if (options.run) {
        try {
          await slackApp.client.chat.delete({
            channel: message.channel.id,
            ts: message.ts,
            token: process.env.SLACK_USER_TOKEN,
          });
        } catch (e) {
          if (e.data.error === 'message_not_found') {
            continue;
          } else if (e.data.error === 'cant_delete_message') {
            console.log(`Skipping message because it can't be deleted`);
            continue;
          } else {
            throw e;
          }
        }
      }
    }
  }

  // Deactivate user account
  console.log(`Deactivating user ${user.name} (${user.real_name})...`);
  if (options.run) {
    // await slackApp.client.admin.users.remove({ user_id: bannedUserId, token: process.env.SLACK_USER_TOKEN });
    // We don't have the right permissions to do this, so we'll use another method
    console.log(
      `This script doesn't have permission to deactivate users. Please deactivate ${user.name} (${user.real_name}) manually from: https://opencollective.slack.com/admin.`,
    );
  }
}

main();
