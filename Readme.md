# Open Collective CLI Tools

## GitHub Sponsors

### CSV Import

1) Add an API Key and production API URL in a `.env` file.

```
API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
API_URL=https://api.opencollective.com
```

2) Download the CSV file 

3) Launch the dry run with:

`node github-sponsors/csv-import.js {CSV_FILE}`

If you see:
- "Detected a new Collective ...", it's recommended to quickly review it and add it to the `csv-import-mapping.json` file.
- "Error finding a matching Collective for GitHub Organization ...", you need to investigate and add an entry in the `csv-import-mapping.json` file.

4) Happy with the dry run? 

`node github-sponsors/csv-import.js {CSV_FILE} --run`
