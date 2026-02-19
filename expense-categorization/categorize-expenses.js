#!/usr/bin/env node

/**
 * Expense Categorization Tool
 *
 * Fetches uncategorized expenses for a given Open Collective account,
 * proposes categories based on similar previously categorized expenses,
 * and interactively asks for user confirmation.
 */

require('../env');

const { Command } = require('commander');
const { gql, request } = require('graphql-request');
const { select, confirm } = require('@inquirer/prompts');
const { pRateLimit } = require('p-ratelimit');

// Rate limiter: 60 requests per minute (OC API allows 100)
const rateLimiter = pRateLimit({
  interval: 60 * 1000,
  rate: 60,
});

const rateLimitedRequest = (endpoint, query, variables) => {
  return rateLimiter(() => request(endpoint, query, variables));
};

// GraphQL endpoint
const getEndpoint = () => {
  return process.env.PERSONAL_TOKEN
    ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
    : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;
};

// ============================================================================
// GraphQL Queries
// ============================================================================

const collectiveHostQuery = gql`
  query CollectiveHost($slug: String!) {
    # Try to get as a host directly
    host(slug: $slug) {
      id
      slug
      name
      accountingCategories(kind: [EXPENSE]) {
        totalCount
        nodes {
          id
          code
          name
          friendlyName
          hostOnly
          expensesTypes
        }
      }
    }
    # Also get as account to find parent host if not a host itself
    account(slug: $slug) {
      id
      slug
      name
      type
      ... on AccountWithHost {
        host {
          id
          slug
          name
          accountingCategories(kind: [EXPENSE]) {
            totalCount
            nodes {
              id
              code
              name
              friendlyName
              hostOnly
              expensesTypes
            }
          }
        }
      }
    }
  }
`;

const expensesQuery = gql`
  query Expenses($slug: String!, $limit: Int!, $offset: Int!, $status: [ExpenseStatusFilter!]) {
    expenses(
      account: { slug: $slug }
      limit: $limit
      offset: $offset
      status: $status
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      nodes {
        id
        legacyId
        description
        longDescription
        type
        status
        createdAt
        currency
        amount
        amountV2 {
          value
          currency
        }
        payee {
          id
          slug
          name
          type
        }
        payoutMethod {
          id
          type
          name
        }
        virtualCard {
          id
          name
          last4
        }
        accountingCategory {
          id
          code
          name
          friendlyName
        }
        tags
        items {
          id
          description
          amount
        }
      }
    }
  }
`;

const editExpenseMutation = gql`
  mutation EditExpense($expense: ExpenseUpdateInput!) {
    editExpense(expense: $expense) {
      id
      legacyId
      accountingCategory {
        id
        code
        name
        friendlyName
      }
    }
  }
`;

// ============================================================================
// Similarity Algorithm
// ============================================================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  const len1 = s1.length;
  const len2 = s2.length;

  const matrix = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(null));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculate string similarity (0 to 1)
 */
function stringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(str1, str2) / maxLen;
}

/**
 * Extract keywords from a string
 */
function extractKeywords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

/**
 * Calculate keyword overlap score
 */
function keywordOverlap(text1, text2) {
  const keywords1 = new Set(extractKeywords(text1));
  const keywords2 = new Set(extractKeywords(text2));

  if (keywords1.size === 0 || keywords2.size === 0) return 0;

  const intersection = [...keywords1].filter((k) => keywords2.has(k)).length;
  const union = new Set([...keywords1, ...keywords2]).size;

  return intersection / union; // Jaccard similarity
}

/**
 * Calculate amount similarity (0 to 1)
 * Uses logarithmic scale to handle large differences
 */
function amountSimilarity(amount1, amount2) {
  if (amount1 === 0 && amount2 === 0) return 1;
  if (amount1 === 0 || amount2 === 0) return 0;

  const logDiff = Math.abs(Math.log10(amount1) - Math.log10(amount2));
  return Math.exp(-logDiff);
}

/**
 * Calculate overall similarity score between two expenses
 * Virtual card and description are primary factors
 */
function calculateSimilarity(expense1, expense2) {
  // Check virtual card match (strongest signal)
  const hasVirtualCard1 = !!expense1.virtualCard?.id;
  const hasVirtualCard2 = !!expense2.virtualCard?.id;
  const virtualCardMatch = hasVirtualCard1 && hasVirtualCard2 && expense1.virtualCard.id === expense2.virtualCard.id;

  // Description similarity
  const descSim = stringSimilarity(expense1.description, expense2.description);

  // Keyword overlap
  const fullText1 = `${expense1.description} ${expense1.longDescription || ''} ${(expense1.tags || []).join(' ')}`;
  const fullText2 = `${expense2.description} ${expense2.longDescription || ''} ${(expense2.tags || []).join(' ')}`;
  const keywordSim = keywordOverlap(fullText1, fullText2);

  // Combined description score
  const descriptionScore = descSim * 0.6 + keywordSim * 0.4;

  // If same virtual card, that's the strongest signal - always prioritize
  if (virtualCardMatch) {
    return 0.85 + descriptionScore * 0.15;
  }

  // Check if virtual card names match (e.g., both are "Travel" cards)
  const cardName1 = expense1.virtualCard?.name?.toLowerCase() || '';
  const cardName2 = expense2.virtualCard?.name?.toLowerCase() || '';
  const cardNameMatch =
    cardName1 &&
    cardName2 &&
    (cardName1 === cardName2 || cardName1.includes(cardName2) || cardName2.includes(cardName1));

  if (cardNameMatch) {
    return 0.5 + descriptionScore * 0.4;
  }

  // No virtual card match - score based on content similarity
  let score = 0;

  // Same payee is a strong signal (same vendor = likely same category)
  if (expense1.payee?.slug && expense1.payee.slug === expense2.payee?.slug) {
    score += 0.4;
  } else {
    const payeeSim = stringSimilarity(expense1.payee?.name, expense2.payee?.name);
    if (payeeSim > 0.8) {
      score += 0.3;
    } else {
      score += payeeSim * 0.15;
    }
  }

  // Description similarity
  score += descSim * 0.35;

  // Keyword overlap
  score += keywordSim * 0.2;

  // Amount similarity (minor factor)
  const amt1 = Math.abs(expense1.amountV2?.value || expense1.amount / 100);
  const amt2 = Math.abs(expense2.amountV2?.value || expense2.amount / 100);
  score += amountSimilarity(amt1, amt2) * 0.05;

  return score;
}

/**
 * Find most similar categorized expenses
 */
function findSimilarExpenses(uncategorizedExpense, categorizedExpenses, limit = 5) {
  const similarities = categorizedExpenses.map((exp) => ({
    expense: exp,
    score: calculateSimilarity(uncategorizedExpense, exp),
  }));

  similarities.sort((a, b) => b.score - a.score);

  return similarities.slice(0, limit);
}

/**
 * Propose a category based on similar expenses
 */
function proposeCategory(similarExpenses) {
  if (similarExpenses.length === 0) {
    return { category: null, confidence: 0 };
  }

  const categoryScores = {};

  for (const { expense, score } of similarExpenses) {
    const catId = expense.accountingCategory.id;
    if (!categoryScores[catId]) {
      categoryScores[catId] = {
        category: expense.accountingCategory,
        scores: [],
      };
    }
    categoryScores[catId].scores.push(score);
  }

  let bestCategory = null;
  let bestConfidence = 0;

  for (const catId in categoryScores) {
    const { category, scores } = categoryScores[catId];
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const consistencyBonus = Math.min(0.1, (scores.length - 1) * 0.025);
    const confidence = Math.min(1, avgScore + consistencyBonus);

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestCategory = category;
    }
  }

  return {
    category: bestCategory,
    confidence: bestConfidence,
  };
}

// ============================================================================
// Display Helpers
// ============================================================================

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount);
}

function formatExpense(expense, collectiveSlug) {
  const amount = expense.amountV2?.value || expense.amount / 100;
  const currency = expense.amountV2?.currency || expense.currency;
  const date = expense.createdAt
    ? new Date(expense.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'N/A';

  const virtualCard = expense.virtualCard
    ? `${expense.virtualCard.name || 'Virtual Card'}${expense.virtualCard.last4 ? ` (****${expense.virtualCard.last4})` : ''}`
    : null;

  const expenseUrl = `https://opencollective.com/${collectiveSlug}/expenses/${expense.legacyId}`;

  return [
    `  ID: ${expense.legacyId}`,
    `  URL: ${expenseUrl}`,
    `  Date: ${date}`,
    `  Description: ${expense.description}`,
    `  Amount: ${formatCurrency(amount, currency)}`,
    `  Type: ${expense.type}`,
    virtualCard ? `  Virtual Card: ${virtualCard}` : null,
    `  Payee: ${expense.payee?.name || expense.payee?.slug || 'N/A'}`,
    `  Payout Method: ${expense.payoutMethod?.type || 'N/A'}`,
    expense.tags?.length ? `  Tags: ${expense.tags.join(', ')}` : null,
    expense.accountingCategory
      ? `  Category: ${expense.accountingCategory.friendlyName || expense.accountingCategory.name} (${expense.accountingCategory.code})`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSimilarExpense(item, index) {
  const { expense, score } = item;
  const amount = expense.amountV2?.value || expense.amount / 100;
  const currency = expense.amountV2?.currency || expense.currency;
  const virtualCard = expense.virtualCard
    ? expense.virtualCard.name || (expense.virtualCard.last4 ? `****${expense.virtualCard.last4}` : 'Card')
    : null;
  const tags = expense.tags?.length ? expense.tags.join(', ') : null;

  const details = [
    formatCurrency(amount, currency),
    virtualCard ? `Card: ${virtualCard}` : null,
    tags ? `Tags: ${tags}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return [
    `  ${index + 1}. [Score: ${(score * 100).toFixed(1)}%] ${expense.description}`,
    `     ${details}`,
    `     Category: ${expense.accountingCategory.friendlyName || expense.accountingCategory.name}`,
  ].join('\n');
}

// ============================================================================
// Main Logic
// ============================================================================

async function fetchAllExpenses(slug, endpoint, status = null) {
  const allExpenses = [];
  const limit = 100;
  let offset = 0;
  let totalCount = null;

  console.log(`Fetching expenses for ${slug}...`);

  while (totalCount === null || offset < totalCount) {
    const variables = { slug, limit, offset, status };
    const data = await rateLimitedRequest(endpoint, expensesQuery, variables);

    if (totalCount === null) {
      totalCount = data.expenses.totalCount;
      console.log(`Total expenses: ${totalCount}`);
    }

    allExpenses.push(...data.expenses.nodes);
    offset += limit;

    if (offset < totalCount) {
      process.stdout.write(`  Fetched ${allExpenses.length}/${totalCount}...\r`);
    }
  }

  console.log(`Fetched ${allExpenses.length} expenses.`);
  return allExpenses;
}

async function fetchHostAndCategories(slug, endpoint) {
  console.log(`Fetching host and accounting categories for ${slug}...`);
  const data = await rateLimitedRequest(endpoint, collectiveHostQuery, { slug });

  let host;
  let categories;

  if (data.host) {
    host = data.host;
    categories = data.host.accountingCategories?.nodes || [];
    console.log(`Account is a host: ${host.name} (${host.slug})`);
  } else if (data.account?.host) {
    host = data.account.host;
    categories = host.accountingCategories?.nodes || [];
    console.log(`Host: ${host.name} (${host.slug})`);
  } else if (data.account) {
    throw new Error(`Account ${slug} (${data.account.type}) has no host and is not a host itself`);
  } else {
    throw new Error(`Account not found: ${slug}`);
  }

  console.log(`Found ${categories.length} accounting categories.`);

  return { host, categories };
}

async function updateExpenseCategory(expenseId, categoryId, endpoint, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would update expense to category ${categoryId}`);
    return { success: true, dryRun: true };
  }

  const variables = {
    expense: {
      id: expenseId,
      accountingCategory: { id: categoryId },
    },
  };

  const result = await rateLimitedRequest(endpoint, editExpenseMutation, variables);
  return { success: true, result: result.editExpense };
}

async function processExpenses(options) {
  const endpoint = getEndpoint();
  const { slug, run: isRun, limit: maxToProcess, minScore, status, autoApprove, showSimilar, after, before } = options;

  // Production safety check
  const isProduction = process.env.API_URL && process.env.API_URL.includes('api.opencollective.com');
  if (isRun && isProduction) {
    console.log('\n⚠️  WARNING: You are about to modify expenses in PRODUCTION! ⚠️');
    console.log(`   API: ${process.env.API_URL}\n`);

    const confirmed = await confirm({
      message: 'Are you sure you want to continue?',
      default: false,
    });

    if (!confirmed) {
      console.log('Operation cancelled.');
      return;
    }
  }

  // Fetch host and accounting categories
  const { categories } = await fetchHostAndCategories(slug, endpoint);

  if (categories.length === 0) {
    console.log('No accounting categories found for this host.');
    return;
  }

  // Fetch all expenses
  const statusFilter = status ? status.toUpperCase().split(',') : null;
  const allExpenses = await fetchAllExpenses(slug, endpoint, statusFilter);

  // Separate categorized and uncategorized
  // Only use categorized expenses from the last year to inform suggestions
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const categorized = allExpenses.filter((e) => {
    if (!e.accountingCategory) return false;
    const expenseDate = new Date(e.createdAt);
    return expenseDate >= oneYearAgo;
  });
  let uncategorized = allExpenses.filter((e) => !e.accountingCategory);

  // Apply date filters
  const afterDate = after ? new Date(after) : null;
  const beforeDate = before ? new Date(before) : null;

  if (afterDate || beforeDate) {
    const beforeFilter = uncategorized.length;
    uncategorized = uncategorized.filter((e) => {
      const expenseDate = new Date(e.createdAt);
      if (afterDate && expenseDate < afterDate) return false;
      if (beforeDate && expenseDate > beforeDate) return false;
      return true;
    });
    console.log(
      `\nDate filter: ${afterDate ? `after ${after}` : ''}${afterDate && beforeDate ? ' and ' : ''}${beforeDate ? `before ${before}` : ''}`,
    );
    console.log(`Filtered: ${beforeFilter} → ${uncategorized.length} uncategorized expenses`);
  }

  console.log(`\nCategorized expenses: ${categorized.length}`);
  console.log(`Uncategorized expenses: ${uncategorized.length}`);

  if (uncategorized.length === 0) {
    console.log('\nNo uncategorized expenses found. Nothing to do!');
    return;
  }

  if (categorized.length === 0) {
    console.log('\nNo categorized expenses to learn from. Cannot make suggestions.');
    console.log('You will need to manually select categories for each expense.');
  }

  // Build category choices for manual selection
  const categoryChoices = categories
    .filter((c) => !c.hostOnly)
    .map((c) => ({
      name: `${c.friendlyName || c.name} (${c.code})`,
      value: c.id,
    }));

  categoryChoices.push({ name: 'Skip this expense', value: 'skip' });
  categoryChoices.push({ name: 'Quit', value: 'quit' });

  // Process uncategorized expenses
  const toProcess = maxToProcess ? uncategorized.slice(0, maxToProcess) : uncategorized;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${toProcess.length} uncategorized expenses (newest first)...`);
  console.log(`${'='.repeat(60)}\n`);

  let processed = 0;
  let skipped = 0;
  let updated = 0;
  let autoApprovedCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const expense = toProcess[i];

    console.log(`\n--- Expense ${i + 1}/${toProcess.length} ---`);
    console.log(formatExpense(expense, slug));

    let proposedCategory = null;
    let similarExpenses = [];

    // Find similar expenses and propose category
    if (categorized.length > 0) {
      similarExpenses = findSimilarExpenses(expense, categorized, 5);
      const proposal = proposeCategory(similarExpenses);

      if (proposal.category && proposal.confidence >= minScore) {
        proposedCategory = proposal;

        const categoryName = proposal.category.friendlyName || proposal.category.name;
        const confidencePercent = (proposal.confidence * 100).toFixed(0);
        const confidenceColor =
          proposal.confidence >= 0.7 ? '\x1b[32m' : proposal.confidence >= 0.5 ? '\x1b[33m' : '\x1b[31m';
        const reset = '\x1b[0m';
        const bold = '\x1b[1m';

        // Deterministic color based on category code/name
        const categoryColors = [
          '\x1b[38;5;39m',
          '\x1b[38;5;171m',
          '\x1b[38;5;208m',
          '\x1b[38;5;45m',
          '\x1b[38;5;141m',
          '\x1b[38;5;75m',
          '\x1b[38;5;213m',
          '\x1b[38;5;81m',
          '\x1b[38;5;147m',
          '\x1b[38;5;183m',
          '\x1b[38;5;117m',
          '\x1b[38;5;176m',
          '\x1b[38;5;73m',
          '\x1b[38;5;139m',
          '\x1b[38;5;111m',
          '\x1b[38;5;218m',
        ];
        const hashStr = proposal.category.code || proposal.category.name;
        const hash = [...hashStr].reduce((acc, char, i) => (acc * 31 + char.charCodeAt(0) * (i + 1)) % 1000003, 0);
        const categoryColor = categoryColors[hash % categoryColors.length];

        console.log(
          `\nProposed category: ${bold}${categoryColor}${categoryName} (${proposal.category.code})${reset} - ${confidenceColor}${confidencePercent}% confidence${reset}\n`,
        );
        if (showSimilar) {
          console.log('Similar expenses:');
          similarExpenses.forEach((item, idx) => console.log(formatSimilarExpense(item, idx)));
        }
      } else {
        console.log(`\nNo confident category suggestion (confidence: ${(proposal.confidence * 100).toFixed(1)}%)`);
      }
    }

    // Auto-approve high confidence matches
    if (autoApprove && proposedCategory && proposedCategory.confidence >= autoApprove) {
      console.log(
        `  [AUTO-APPROVE] Confidence ${(proposedCategory.confidence * 100).toFixed(0)}% >= ${(autoApprove * 100).toFixed(0)}% threshold`,
      );

      try {
        const result = await updateExpenseCategory(expense.id, proposedCategory.category.id, endpoint, !isRun);
        if (result.success) {
          console.log(`  ✓ Updated to: ${proposedCategory.category.friendlyName || proposedCategory.category.name}`);
          updated++;
          autoApprovedCount++;
          expense.accountingCategory = result.result?.accountingCategory || proposedCategory.category;
          categorized.push(expense);
        }
      } catch (error) {
        console.error(`  ✗ Error updating expense: ${error.message}`);
      }

      processed++;
      continue;
    }

    // Ask user for confirmation
    const choices = [];

    if (proposedCategory) {
      choices.push({
        name: `Accept: ${proposedCategory.category.friendlyName || proposedCategory.category.name} (${proposedCategory.category.code})`,
        value: proposedCategory.category.id,
      });
    }

    choices.push({ name: 'Select different category...', value: 'select' });
    choices.push({ name: 'Skip this expense', value: 'skip' });
    choices.push({ name: 'Quit', value: 'quit' });

    const action = await select({
      message: 'What would you like to do?',
      choices,
    });

    if (action === 'quit') {
      console.log('\nQuitting...');
      break;
    }

    if (action === 'skip') {
      console.log('  Skipped.');
      skipped++;
      processed++;
      continue;
    }

    let selectedCategoryId = action;

    if (action === 'select') {
      const category = await select({
        message: 'Select a category:',
        choices: categoryChoices,
      });

      if (category === 'skip') {
        console.log('  Skipped.');
        skipped++;
        processed++;
        continue;
      }

      if (category === 'quit') {
        console.log('\nQuitting...');
        break;
      }

      selectedCategoryId = category;
    }

    // Update the expense
    try {
      const result = await updateExpenseCategory(expense.id, selectedCategoryId, endpoint, !isRun);
      if (result.success) {
        const selectedCat = categories.find((c) => c.id === selectedCategoryId);
        console.log(`  ✓ Updated to: ${selectedCat?.friendlyName || selectedCat?.name || selectedCategoryId}`);
        updated++;
        expense.accountingCategory = selectedCat;
        categorized.push(expense);
      }
    } catch (error) {
      console.error(`  ✗ Error updating expense: ${error.message}`);
    }

    processed++;
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary:');
  console.log(`  Processed: ${processed}`);
  console.log(`  Updated: ${updated}${autoApprovedCount > 0 ? ` (${autoApprovedCount} auto-approved)` : ''}`);
  console.log(`  Skipped: ${skipped}`);
  if (!isRun) {
    console.log('\n  [DRY RUN] No changes were made. Use --run to apply changes.');
  }
  console.log(`${'='.repeat(60)}`);
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('categorize-expenses')
  .description('Interactively categorize expenses for an Open Collective account')
  .argument('<slug>', 'The collective slug to process expenses for')
  .option('--run', 'Apply changes (default is dry-run mode)')
  .option('--limit <number>', 'Maximum number of expenses to process', parseInt)
  .option('--min-score <number>', 'Minimum confidence score to suggest a category (0-1)', parseFloat, 0.3)
  .option('--auto-approve <number>', 'Auto-approve matches with confidence >= this threshold (0-1)', parseFloat)
  .option('--status <statuses>', 'Comma-separated expense statuses to filter', 'PAID,APPROVED')
  .option('--after <date>', 'Only process expenses after this date (YYYY-MM-DD)')
  .option('--before <date>', 'Only process expenses before this date (YYYY-MM-DD)')
  .option('--show-similar', 'Show similar expenses used for category suggestion')
  .action(async (slug, options) => {
    const isProduction = process.env.API_URL && process.env.API_URL.includes('api.opencollective.com');

    console.log(`\nExpense Categorization Tool`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Collective: ${slug}`);
    console.log(`Mode: ${options.run ? 'LIVE' : 'DRY RUN'}`);
    console.log(`Environment: ${isProduction ? '🔴 PRODUCTION' : '🟢 Staging/Dev'}`);
    console.log(`API: ${process.env.API_URL}`);
    if (options.limit) console.log(`Limit: ${options.limit} expenses`);
    if (options.status) console.log(`Status filter: ${options.status}`);
    console.log(`Min confidence: ${(options.minScore * 100).toFixed(0)}%`);
    if (options.autoApprove) console.log(`Auto-approve threshold: ${(options.autoApprove * 100).toFixed(0)}%`);
    console.log(`${'='.repeat(60)}\n`);

    await processExpenses({
      slug,
      run: options.run,
      limit: options.limit,
      minScore: options.minScore,
      autoApprove: options.autoApprove,
      status: options.status,
      after: options.after,
      before: options.before,
      showSimilar: options.showSimilar,
    });
  });

// Entry point
if (!module.parent) {
  program.parseAsync(process.argv).catch((e) => {
    if (e.name !== 'CommanderError') {
      console.error(e);
    }
    process.exit(1);
  });
}

module.exports = { processExpenses, calculateSimilarity, findSimilarExpenses, proposeCategory };
