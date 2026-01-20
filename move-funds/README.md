# Move Funds

Tool to move funds from collectives to other accounts (e.g., ecosystem funds) via expense creation and payment.

## Prerequisites

- Node.js
- Valid `.env` file with `API_URL` and `PERSONAL_TOKEN` (or `API_KEY`)

## Usage

### Step 1: Create and Approve Expenses

```bash
# Dry run (no changes made)
node move-funds/create-expenses.js path/to/input.csv

# Run for real (will prompt for 2FA)
node move-funds/create-expenses.js path/to/input.csv --run

# Limit to first 10 expenses
node move-funds/create-expenses.js path/to/input.csv --run --limit 10

# With YubiKey for 2FA
node move-funds/create-expenses.js path/to/input.csv --run --yubikey
```

This creates INVOICE expenses with `ACCOUNT_BALANCE` payout method (internal transfer) and approves them immediately.

Output: A JSON file (`input-expenses.json`) with expense IDs for the pay step.

### Step 2: Pay Expenses

```bash
# Dry run
node move-funds/pay-expenses.js path/to/input-expenses.json

# Run for real
node move-funds/pay-expenses.js path/to/input-expenses.json --run

# Limit to first 10 expenses
node move-funds/pay-expenses.js path/to/input-expenses.json --run --limit 10
```

## CSV Format

Expected columns:

- `Balance`: Amount to transfer (e.g., `$37.80` or `$1,175.13`)
- `Open Collective`: Source collective URL (e.g., `https://opencollective.com/my-collective`)
- `fund url`: Destination account URL (e.g., `https://opencollective.com/ecosystem-funds/projects/oc-python-fund`)
- `Collective`: Name of the collective (used in expense description)

Rows without valid source URL, destination URL, or with zero balance are skipped.

## Rate Limiting

Uses `p-ratelimit` with 60 requests per minute to stay within API limits.
