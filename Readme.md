# Open Collective CLI Tools

## Prerequisite

1. Add an API Key (Personal Token) and production API URL in a `.env` file.

```
API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
API_URL=https://api.opencollective.com
```

2. Run `npm install`

## GitHub Sponsors

### CSV Import

1. Download the CSV file

2. Launch the dry run with:

`node github-sponsors/csv-import.js {CSV_FILE}`

If you see:

- "Detected a new Collective ...", it's recommended to quickly review it and add it to the `csv-import-mapping.json` file.
- "Error finding a matching Collective for GitHub Organization ...", you need to investigate and add an entry in the `csv-import-mapping.json` file.

3. Happy with the dry run?

`node github-sponsors/csv-import.js {CSV_FILE} --run`

## 1kproject

To run the scripts, you need to be an admin of https://opencollective.com/ukrainian-families-1k and https://opencollective.com/foundation. Ask someone to invite you beforehand if necessary.

1. Download the CSV file and name it with a shorter name like `Bulk_07_21.csv`

2. Launch the dry run for Expense Creation with:

`node 1kproject/create-expenses.js Bulk_07_21.csv`

Check any warning before proceeding, if there is a problem remove the entries from the CSV.

3. Once happy with the dry run, launch Expense Creation with:

`node 1kproject/create-expenses.js Bulk_07_21.csv --run`

Note: Add `--split` parameter to the above command to split the expense into two ($500 each):

`node 1kproject/create-expenses.js Bulk_07_21.csv --split --run`

4. Trigger the dry run for Expense Payment with:

`node 1kproject/pay-expenses.js`

Check that the number of approved Expenses is the expected one and that there is no warning.

5. Proceed Expense Payments with, enter your 2FA token when asked.

`node 1kproject/pay-expenses.js --run`
