/**
 * A script to enrich the Slack members CSV (from https://opencollective.slack.com/admin) with additional
 * information from the Slack API.
 */

require('../env');

const { Command } = require('commander');
const { App } = require('@slack/bolt');
const { difference, partition, flatten, uniq } = require('lodash');
const { SLACK_BOT_ID, TEAM_ID } = require('./_constants');
const fs = require('fs');
const { formatUserName } = require('./_lib');
const CSVParseSync = require('csv-parse/sync');
const CSVStringifySync = require('csv-stringify/sync');

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
  program.arguments('<input-file>');
  program.parse(argv);
  return program;
};

// const COLUMNS_TO_ADD = ['is_email_confirmed','is_bot', 'deleted', 'updated'];

const COLUMNS_TO_ADD = [
  { name: 'is_email_confirmed' },
  { name: 'is_bot' },
  { name: 'deleted' },
  { name: 'updated', transform: (value) => new Date(value * 1000).toISOString() },
];

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slackApp = getSlackApp();

  // Load file
  const inputFileName = program.args[0];
  const outputFileName = inputFileName.replace('.csv', '-enriched.csv');
  const file = fs.readFileSync(inputFileName, 'utf8');
  const records = CSVParseSync.parse(file, { columns: true });

  // Iterate over records
  for (const row of records) {
    // Get base profile info
    const { user } = await slackApp.client.users.info({ user: row['userid'] });
    for (const column of COLUMNS_TO_ADD) {
      const value = column.transform ? column.transform(user[column.name]) : user[column.name];
      row[column.name] = value;
    }

    // Use the search API to get all messages from user
    const { messages } = await slackApp.client.search.all({
      query: `from:${user.name}`,
      sort: 'timestamp',
      sort_dir: 'desc',
      token: process.env.SLACK_USER_TOKEN,
      count: 1,
    });

    row['messages_posted'] = messages.total;
    if (messages.matches[0]?.ts) {
      row['last_message_date'] = new Date(messages.matches[0].ts * 1000).toISOString();
    }
  }

  // Write to file
  const baseKeys = Object.keys(records[0]);
  const columns = uniq([
    ...baseKeys,
    ...COLUMNS_TO_ADD.map((column) => column.name),
    'messages_posted',
    'last_message_date',
  ]);

  const output = CSVStringifySync.stringify(records, { header: true, columns });
  fs.writeFileSync(outputFileName, output);
  console.log(`Output written to ${outputFileName}`);
}

main();
