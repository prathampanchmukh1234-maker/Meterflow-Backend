# MeterFlow Backend

Express API server for MeterFlow.

## Local Development

```bash
npm install
npm run dev
```

The API runs on `http://localhost:3000`.

## Render Deployment

Use this repository as a Render Node web service.

- Build command: `npm install`
- Start command: `npm run start`
- Health check path: `/`

Required environment variables are listed in `.env.example`.

## Database

Run the Supabase SQL files from `database/` in your Supabase SQL editor before using the app.
