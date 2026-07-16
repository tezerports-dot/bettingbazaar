# Betting Bazaar - 3D Prediction Market

The premier high-frequency prediction platform. Bet on Delhi vs Bombay in real-time with an immersive 3D interface, P2P merchant system, and algorithmic game cycles.

## 🚀 Deployment Guide (For No-Coders)

### 1. Database Setup (MongoDB)
* Create a free account at [mongodb.com](https://www.mongodb.com/).
* Create a Cluster and a Database User (keep the password safe).
* In "Network Access", allow access from "0.0.0.0/0" (Everywhere).
* Copy your Connection String (looks like `mongodb+srv://...`).

### 2. Hosting Setup (Railway)
* Go to [railway.app](https://railway.app/) and login with GitHub.
* Click "+ New Project" -> "Deploy from GitHub repo".
* Select the `betting-bazaar` repository.
* Go to the **Variables** tab in Railway and add:
  * `MONGO_URI`: (Paste your MongoDB string here)
  * `JWT_SECRET`: (Type any long random text)
  * `NODE_ENV`: `production`
  * `REDIS_URL`: (Optional - Railway can add a Redis service for you)

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
