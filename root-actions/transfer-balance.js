require('../env');

const { Command } = require('commander');

const { request, gql } = require('graphql-request');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const accountQuery = gql`
  query Account($slug: String) {
    account(slug: $slug) {
      id
      type
      slug
      name
      stats {
        balance {
          valueInCents
          currency
        }
      }
      ... on AccountWithHost {
        host {
          id
          slug
          name
        }
      }
      ... on AccountWithParent {
        parent {
          id
          slug
          name
        }
      }
    }
  }
`;

const transferBalanceMutation = gql`
  mutation TransferBalance(
    $fromAccount: AccountReferenceInput!
    $toAccount: AccountReferenceInput!
    $amount: AmountInput
    $message: String
  ) {
    rootTransferBalance(fromAccount: $fromAccount, toAccount: $toAccount, amount: $amount, message: $message) {
      id
      legacyId
      amount {
        valueInCents
        currency
      }
      fromAccount {
        id
        slug
        name
      }
      toAccount {
        id
        slug
        name
      }
    }
  }
`;

const catchException = (e) => {
  console.log(e);
  return null;
};

async function fetchAccountWithSlug(slug) {
  const data = await request(endpoint, accountQuery, { slug }).catch(catchException);
  return data?.account;
}

function formatCurrency(valueInCents, currency) {
  return `${(valueInCents / 100).toFixed(2)} ${currency}`;
}

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [fromSlug, toSlug] = program.args;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.\n`);
  }

  const fromAccount = await fetchAccountWithSlug(fromSlug);
  if (!fromAccount) {
    console.error(`Error: Could not find account with slug "${fromSlug}"`);
    return;
  }

  const toAccount = await fetchAccountWithSlug(toSlug);
  if (!toAccount) {
    console.error(`Error: Could not find account with slug "${toSlug}"`);
    return;
  }

  const balance = fromAccount.stats.balance;
  console.log(`From: "${fromAccount.name}" (${fromAccount.slug}) [${fromAccount.type}]`);
  console.log(`  Balance: ${formatCurrency(balance.valueInCents, balance.currency)}`);
  if (fromAccount.parent) {
    console.log(`  Parent: "${fromAccount.parent.name}" (${fromAccount.parent.slug})`);
  }
  if (fromAccount.host) {
    console.log(`  Host: "${fromAccount.host.name}" (${fromAccount.host.slug})`);
  }
  console.log(`To: "${toAccount.name}" (${toAccount.slug}) [${toAccount.type}]`);

  if (balance.valueInCents === 0) {
    console.log(`\nBalance is already 0, nothing to transfer.`);
    return;
  }

  const variables = {
    fromAccount: { slug: fromSlug },
    toAccount: { slug: toSlug },
  };

  if (options.amount) {
    const valueInCents = Math.round(parseFloat(options.amount) * 100);
    variables.amount = { valueInCents, currency: balance.currency };
    console.log(`\nTransferring ${formatCurrency(valueInCents, balance.currency)}${!options.run ? ' (dry run)' : ''}`);
  } else {
    console.log(
      `\nTransferring full balance: ${formatCurrency(balance.valueInCents, balance.currency)}${!options.run ? ' (dry run)' : ''}`,
    );
  }

  if (options.message) {
    variables.message = options.message;
    console.log(`Message: "${options.message}"`);
  }

  if (options.run) {
    const result = await request(endpoint, transferBalanceMutation, variables);
    console.log(`\nTransfer complete!`);
    console.log(`Order ID: ${result.rootTransferBalance.id} (legacy: ${result.rootTransferBalance.legacyId})`);
    console.log(
      `Amount: ${formatCurrency(result.rootTransferBalance.amount.valueInCents, result.rootTransferBalance.amount.currency)}`,
    );
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<from-slug>', 'Slug of the source account (balance goes down)');
  program.argument('<to-slug>', 'Slug of the destination account (balance goes up)');

  program.option('--run', 'Actually execute the transfer (dry run by default).');
  program.option(
    '--amount <amount>',
    'Amount to transfer (in major currency unit, e.g. 10.50). Defaults to full balance.',
  );
  program.option('--message <message>', 'Optional reason for the audit trail.');

  program.parse(argv);

  return program;
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }

      process.exit(1);
    });
}
