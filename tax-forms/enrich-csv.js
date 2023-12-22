/**
 * Enrich a tax form CSV with data from HelloWorks
 */

const fs = require('fs');
const { Command } = require('commander');
const { parse } = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require
const HelloWorks = require('helloworks-sdk');

const HELLO_WORKS_KEY = get(config, 'helloworks.key');
const HELLO_WORKS_SECRET = get(config, 'helloworks.secret');
const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');

if (!HELLO_WORKS_KEY || !HELLO_WORKS_SECRET || !HELLO_WORKS_WORKFLOW_ID) {
  throw new Error('Missing HelloWorks configuration');
}

const getProgram = (argv) => {
  const program = new Command();
  program.argument('<csvFile>', 'CSV file to enrich');
  program.parse(argv);
  return program;
};

const getHelloWorksInstanceIds = (row) => {
  const rawTxt = row['helloworksInstanceId'];
  const idsListStr = /\{(.*)\}/.exec(rawTxt)[1];
  return idsListStr
    .split(',')
    .map((id) => (id === 'NULL' ? null : id))
    .filter(Boolean);
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const csvFile = program.args[0];
  const fileContent = fs.readFileSync(csvFile, 'utf8');
  const parsedCSV = parse(fileContent, { columns: true });
  const client = new HelloWorks({ apiKeyId: HELLO_WORKS_KEY, apiKeySecret: HELLO_WORKS_SECRET });

  for (const row of parsedCSV) {
    // Get helloworks instance ids
    const instanceIds = getHelloWorksInstanceIds(row);
    if (instanceIds.length === 0) {
      console.log(`No instance ids for ${row['profile']}`);
      continue;
    } else if (instanceIds.length > 1) {
      console.log(`Multiple instance ids for ${row['profile']}, only the first one will be used`);
    }

    // Fetch info from HelloWorks
    client.work;
  }
}

main();
