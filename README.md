# Quiz Backend

A Node.js backend application for quiz generation and historical economic data retrieval.

## Features

- **Quiz Generation**: AI-powered quiz generation using DeepSeek API
- **Historical Data API**: Support for GDP and GDP_PPP metrics
- **Score Tracking**: Quiz score submission and leaderboard
- **Metric Selection**: Support for both GDP and GDP (Purchasing Power Parity) metrics

## API Endpoints

### Historical Data Endpoints (New)

#### Get Available Metrics
```
GET /api/metrics
```
Returns available metrics for dropdown selection:
- GDP (Gross Domestic Product)
- GDP_PPP (GDP Purchasing Power Parity)

#### Fetch Historical Data
```
GET /api/historical-data
```

**Parameters:**
- `metric` - GDP or GDP_PPP (default: GDP)
- `country` - Filter by country name (optional)
- `year_start` - Filter by start year (optional) 
- `year_end` - Filter by end year (optional)

**Examples:**
```bash
# Get all GDP data
curl "http://localhost:3001/api/historical-data?metric=GDP"

# Get GDP_PPP data for China
curl "http://localhost:3001/api/historical-data?metric=GDP_PPP&country=China"

# Get GDP data for years 2021-2022
curl "http://localhost:3001/api/historical-data?metric=GDP&year_start=2021&year_end=2022"
```

#### Sample Data
```
GET /api/seed-historical-data
```
Returns sample historical data for testing.

### Other Endpoints

- `GET /api/health` - Health check
- `GET /api/docs` - API documentation
- `POST /api/generate-quiz` - Generate quiz questions
- `POST /api/submit-answers` - Submit quiz answers
- `GET /api/leaderboard` - Get leaderboard

## Running the Server

```bash
npm start
```

The server will run on port 3001 by default.

## Environment Variables

- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `DEEPSEEK_API_KEY` - DeepSeek AI API key
- `PORT` - Server port (default: 3001)

## Data Format

The historical data includes both GDP and GDP_PPP values for each country/year:

```json
{
  "metric": "GDP_PPP",
  "data": [
    {
      "country": "United States",
      "year": 2020,
      "GDP": 20950000,
      "GDP_PPP": 20950000,
      "value": 20950000
    }
  ],
  "count": 15
}
```