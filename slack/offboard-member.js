require('../env');

const { Command } = require('commander');
const { App } = require('@slack/bolt');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
} else if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error('Missing environment variable: SLACK_SIGNING_SECRET');
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
  program.argument('<id>', 'User ID of the member to offboard');
  program.option('--run', 'Trigger actual offboarding');
  program.parse(argv);
  return program;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slackApp = getSlackApp();
  const offboardedUserId = program.args[0];

  // Get offboarded user's name
  const { user } = await slackApp.client.users.info({ user: offboardedUserId });

  // List all private channels in the workspace
  const { channels } = await slackApp.client.conversations.list({ types: 'private_channel' });

  // Add members to all channel
  await Promise.all(
    channels.map(async (channel) => {
      const { members } = await slackApp.client.conversations.members({ channel: channel.id });
      channel.members = members;
    }),
  );

  // TODO remove from internal teams

  let isInPrivateChannels = false;
  for (const channel of channels) {
    if (channel.members.includes(offboardedUserId)) {
      isInPrivateChannels = true;
      console.log(`Removing @${user.name} (${user.real_name}) from #${channel.name}`);
      if (options.run) {
        // Switch the setting for "People who can remove members from private channels" first
        // See https://opencollective.slack.com/admin/settings#channel_management_restrictions
        await slackApp.client.conversations.kick({ channel: channel.id, user: offboardedUserId });
      }
    }
  }

  if (isInPrivateChannels) {
    console.log('Done! Remember to remove the person from slack/check-members.js too!');
  } else {
    console.log(`@${user.name} (${user.real_name}) is not in any private channel`);
  }
}

main();
