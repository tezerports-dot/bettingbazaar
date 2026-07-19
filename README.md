# Betting Bazaar - 3D Prediction Market

The premier high-frequency prediction platform. Bet on Delhi vs Bombay in real-time with an immersive 3D interface, P2P merchant system, and algorithmic game cycles.

## 🚀 Deployment Guide (For No-Coders)

### 1. Database Setup (MongoDB)
* Create a free account at [mongodb.com](https://www.mongodb.com/).
* Create a Cluster and a Database User (keep the password safe).
* In "Network Access", allow only the backend host's outbound IPs or private
  VPC subnet. Avoid `0.0.0.0/0` for production because it exposes the database
  endpoint to the entire internet.
* Copy your Connection String (looks like `mongodb+srv://...`).

### 2. Hosting Setup (Railway)
* Go to [railway.app](https://railway.app/) and login with GitHub.
* Click "+ New Project" -> "Deploy from GitHub repo".
* Select the `betting-bazaar` repository.
* Keep Railway's root directory pointed at the repository root so it uses the root
  `railway.json` build/start commands.
* Go to the **Variables** tab in Railway and add the production variables from
  `.env.example`. The backend refuses to boot in production unless these minimum
  required values are present:
  * `NODE_ENV`: `production`
  * `MONGODB_URI`: Paste your MongoDB connection string here.
  * `PASETO_SECRET_KEY`: Long random secret used as the PASETO v2.public token seed. `JWT_SECRET` is still accepted as a legacy fallback, but new deployments should set `PASETO_SECRET_KEY` explicitly.
  * `ORDER_HMAC_SECRET`: Long random secret dedicated to payment-order HMACs.
  * `AADHAAR_HMAC_SECRET`: Long random secret dedicated to Aadhaar duplicate-detection HMACs.
  * `REDIS_URL`: Railway-managed Redis URL or another Redis connection string.
  * `ALLOWED_ORIGINS`: Comma-separated trusted frontend origins, including schemes, for each deployed user/admin/merchant panel (for example `https://app.example.com,https://admin.example.com,https://merchant.example.com`). Do not use the backend/API URL unless it is also a browser frontend origin.
  * `DATABASE_URL`: PostgreSQL connection string for the hybrid money datastore.
  * `S3_BUCKET_NAME`: Durable upload bucket name.
  * `METRICS_TOKEN`: Bearer token required for Prometheus metrics.
  * `PUBLIC_APP_ORIGIN`: Official public HTTPS app origin.
  * `PUBLIC_APP_ALLOWED_ORIGINS`: Comma-separated public app origin allow-list.
* Also set the supporting S3/CDN values shown in `.env.example`
  (`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `CDN_URL`)
  before enabling production uploads.

### 3. Local Development
1. Open your Chromebook Terminal.
2. `cd betting-bazaar`
3. `npm ci --legacy-peer-deps`
4. `npm run install:panels`
5. `npm run dev` (user-panel preview)
6. `npm run build:user` (user-panel production build)
7. `npm run start:local` (backend start)

## 📁 Project Structure
* `/user-panel`: Customer-facing React/Vite application.
* `/admin-panel`: Admin React/Vite application.
* `/merchant-panel`: Merchant React/Vite application.
* `/backend`: Node.js/Express API and domain services.

## 🛡️ Security
This app includes:
* TOTP 2FA for Admins.
* User wallet consistency checks.
* P2P Escrow status tracking.
* Bot-mitigation captchas.

---
**Maintained by AI Studio Production Pipeline**
