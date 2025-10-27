// eslint-disable-next-line node/no-missing-require
const { Octokit } = require('@octokit/rest');
const { program } = require('commander');
const { default: inquirer } = require('inquirer');
const dotenv = require('dotenv');
const { partition } = require('lodash');

// Load environment variables
dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_ISSUES_TOKEN,
});

const owner = 'opencollective';
const repo = 'opencollective';

program
  .description('Copy sub-issues from one issue to another')
  .argument('<oldIssue>', 'Source issue ID or URL to copy sub-issues from')
  .argument('<newIssue>', 'Target issue ID or URL to copy sub-issues to')
  .option('--all', 'Transfer all sub-issues (including closed ones)')
  .parse();

function extractIssueId(input) {
  // Check if input is a URL
  try {
    const url = new URL(input);
    if (url.hostname === 'github.com') {
      // Extract ID from path, e.g. /opencollective/opencollective/issues/8096
      const matches = url.pathname.match(/\/issues\/(\d+)$/);
      if (matches) {
        return parseInt(matches[1], 10);
      }
    }
  } catch (e) {
    // Not a URL, assume it's an ID
  }

  return parseInt(input, 10);
}

const [oldInput, newInput] = program.args;
const oldIssueId = extractIssueId(oldInput);
const newIssueId = extractIssueId(newInput);
const options = program.opts();

async function getIssueDetails(issueId) {
  const { data: issue } = await octokit.issues.get({
    owner,
    repo,
    // eslint-disable-next-line camelcase
    issue_number: parseInt(issueId, 10),
  });
  return issue;
}

async function getSubIssues(issueId) {
  const subIssues = [];
  let page = 1;
  // eslint-disable-next-line camelcase
  const per_page = 100;

  let hasMoreData = true;
  while (hasMoreData) {
    const { data } = await octokit.rest.issues.listSubIssues({
      owner,
      repo,
      // eslint-disable-next-line camelcase
      issue_number: issueId,
      // eslint-disable-next-line camelcase
      per_page,
      page,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (data.length === 0) {
      hasMoreData = false;
    } else {
      subIssues.push(...data);
      // eslint-disable-next-line camelcase
      if (data.length < per_page) {
        hasMoreData = false;
      } else {
        page++;
      }
    }
  }

  return subIssues;
}

async function main() {
  try {
    // Get details of both issues
    const [oldIssue, newIssue] = await Promise.all([getIssueDetails(oldIssueId), getIssueDetails(newIssueId)]);

    console.log('\nSource Issue:');
    console.log(`#${oldIssue.number}: ${oldIssue.title}`);
    console.log(oldIssue.body ? `${oldIssue.body.slice(0, 200)}...` : '(no description)');

    console.log('\nTarget Issue:');
    console.log(`#${newIssue.number}: ${newIssue.title}`);
    console.log(newIssue.body ? `${newIssue.body.slice(0, 200)}...` : '(no description)');

    // Get sub-issues
    const subIssues = await getSubIssues(oldIssueId);

    console.log('\nSub-issues:');
    if (subIssues.length === 0) {
      console.log('No sub-issues found.');
      process.exit(0);
    }

    subIssues.forEach((issue, index) => {
      console.log(`${index + 1}. #${issue.number}: ${issue.title} (${issue.state.toLowerCase()})`);
    });

    const [openIssues, closedIssues] = partition(subIssues, (issue) => issue.state === 'open');
    console.log(`\nTotal sub-issues: ${subIssues.length} (Open: ${openIssues.length}, Closed: ${closedIssues.length})`);
    const issuesToTransfer = options.all ? subIssues : openIssues;

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Do you want to transfer these ${issuesToTransfer.length} sub-issues?`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log('Operation cancelled.');
      process.exit(0);
    }

    // Transfer sub-issues by referencing them in comments
    console.log('\nTransferring sub-issues...');

    for (const issue of issuesToTransfer) {
      const comment = `Transferring sub-issue: #${issue.number}`;

      await octokit.issues.removeSubIssue({
        owner,
        repo,
        // eslint-disable-next-line camelcase
        issue_number: parseInt(oldIssueId, 10),
        // eslint-disable-next-line camelcase
        sub_issue_id: issue.id,
      });

      await octokit.issues.addSubIssue({
        owner,
        repo,
        // eslint-disable-next-line camelcase
        issue_number: parseInt(newIssueId, 10),
        // eslint-disable-next-line camelcase
        sub_issue_id: issue.id,
        body: comment,
      });

      console.log(`✓ Transferred #${issue.number}`);
    }

    console.log('\nTransfer completed successfully!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
