# 🌍 Friend Atlas

Map your friendships across the world.

## Quick Start

1. Copy env file and add WorkOS credentials:
   ```bash
   cp .env.example .env
   ```

2. Run with Docker:
   ```bash
   docker-compose up --build
   ```

3. Open http://localhost:3000

## Deploy to Render

1. Push to GitHub
2. Go to render.com → New → Blueprint
3. Connect your repo
4. Add environment variables:
   - WORKOS_API_KEY
   - WORKOS_CLIENT_ID
   - WORKOS_REDIRECT_URI = https://your-app.onrender.com/auth/callback

## WorkOS Setup

1. Sign up at workos.com
2. Create project → Enable AuthKit
3. Add redirect URI
4. Copy API Key and Client ID
