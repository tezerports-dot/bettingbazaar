# Bazaar Clash 3D - Production Specification Document

## 1. Executive Summary
**Product Name:** Bazaar Clash 3D
**Version:** 2.1 Production
**Description:** A high-frequency, casino-style head-to-head prediction market. Users wager on the outcome of two competing "Bazaars" (Delhi vs Bombay) based on volume metrics.
**Platform:** Mobile-First Web Application (PWA Ready).
**Core USP:** 3D immersive betting interface, decentralized P2P merchant wallet system, and algorithmic cycle management.

---

## 2. Design System & Visual Identity
The application strictly follows a dark-mode "Casino Premium" aesthetic.

### 2.1 Color Palette
*   **Backgrounds:**
    *   `#0B0E14`: Main App Background (Deep Navy/Black)
    *   `#121826`: Panels / Modals / Secondary Cards
    *   `#1E293B`: Admin Cards / High Elevation
    *   `#0F172A`: Inputs / Table Headers
*   **Accents:**
    *   `#D4AF37`: Primary Gold (Text, Borders, Active States)
    *   `#F5C77A`: Light Gold (Gradients)
    *   `#B8860B`: Dark Gold (Hover States)
*   **Functional:**
    *   `#E53935`: Delhi Side (Red), Error, Sell
    *   `#1E88E5`: Bombay Side (Blue)
    *   `#25D366`: Success, Deposit, Win (WhatsApp Green)
    *   `#EAEAEA`: Primary Text (Off-White)
    *   `#9AA0A6`: Secondary Text (Muted Grey)

### 2.2 Typography
*   **Font Family:** 'Inter', sans-serif.
*   **Weights:**
    *   Regular (400): Body text.
    *   Bold (700): Headings, Buttons, Values.
    *   Black (900): Hero Numbers, "VS", Winners.
*   **Effects:**
    *   `text-gold-glow`: `text-shadow: 0 0 10px rgba(212, 175, 55, 0.5)`

### 2.3 Interactive Elements
*   **3D Chips:** Custom CSS (`.chip-3d`) using inset shadows and gradients to simulate thickness.
    *   Red Chip: `#C62828`
    *   Green Chip: `#2E7D32`
    *   Blue Chip: `#1565C0`
    *   Purple Chip: `#6A1B9A`
    *   Black Chip: `#212121`
*   **Animations:**
    *   `animate-win-pulse`: For winning card.
    *   `animate-shimmer`: For metallic reflection on chips.
    *   `animate-spin-slow`: Background decorations.

---

## 3. Frontend Architecture

### 3.1 Framework
*   **React 19**: Using Functional Components and Hooks.
*   **Router**: `react-router-dom` (HashRouter for broad compatibility).
*   **Build Tool**: Vite.

### 3.2 State Management (`Context API`)
*   **GameContext**:
    *   Manages `User` session, `Wallet` balance.
    *   Manages `GameCycle` state (Timer, Status, Totals).
    *   Syncs with `serverTimeOffset` to prevent client-side timer manipulation.
    *   Handles `placeBet` logic with optimistic UI updates.
*   **AdminContext**:
    *   Manages `AdminUser` session, `2FA` verification.
    *   Aggregates Dashboard Metrics, Audit Logs, Merchant Data.
    *   Provides methods for `UserManagement`, `Financials`, and `GameOps`.

### 3.3 Backend Abstraction Layer
The application uses the **Interface-based pattern** to allow seamless switching between a simulated local backend and a real remote API.

*   **Interface (`IBackend`)**: `services/backend.interface.ts`
    *   Defines the strict contract for all data operations.
*   **Mock Implementation**: `services/mockBackend.ts`
    *   Persists data to `localStorage`.
    *   Simulates network delay.
    *   Used for development, testing, and demos.
*   **Real Implementation**: `services/realBackend.ts`
    *   Connects to RESTful API endpoints.
    *   Handles JWT authentication headers.
*   **Factory**: `services/api.ts`
    *   Exports the active backend instance based on `import.meta.env.VITE_USE_MOCK`.

### 3.4 Error Handling
*   **Error Wall**: `components/ui/ErrorBoundary.tsx` wraps the entire app. Catches React render errors, logs stack trace to UI (in prod, send to logging service), and provides "Reload" button.

---

## 4. Feature Specifications

### 4.1 Game Mechanics
1.  **Cycle Types**:
    *   **30_MIN**: Runs continuously. 00:00 - 30:00. Betting closes at 28:00.
    *   **FULL_DAY**: 24-hour cycle. Result declared at 18:00 IST.
2.  **States**:
    *   `OPEN`: Betting allowed.
    *   `MERGED`: (Visual Only) 30s before close, pools merge visually to hide trend.
    *   `CLOSED`: Betting disabled. Waiting for result.
    *   `RESULT_DECLARED`: Winner shown, payouts processed.
    *   `PAUSED`: Admin override.
3.  **Betting**:
    *   Min Bet: ₹10 (30 Min), ₹50 (Full Day).
    *   Validation: Check Balance, Check Status, Check Cycle State.
    *   Atomic Update: Deduct balance immediately upon placement.

### 4.2 Wallet & P2P System
1.  **Currency**: 1 Token = 1 INR (Pegged).
2.  **Merchant Entity**:
    *   `dailyCap`: Max volume a merchant can process per day.
    *   `limits`: Min/Max per transaction.
    *   `isOnline`: Toggle availability.
3.  **Deposit Flow**:
    *   User enters Amount -> System checks Merchant availability -> Creates `P2POrder`.
    *   Dynamic Calculation: `Amount * BuyRate`.
    *   UI displays Merchant Rates dynamically.
4.  **Withdrawal Flow**:
    *   User enters Amount -> Checks `lockedBalance` (Wagering Rule) -> Creates `P2POrder`.
    *   Dynamic Calculation: `Amount * SellRate`.
5.  **Rate Management**: Admin sets Buy/Sell rates in `MerchantOps`.

### 4.3 Admin Panel Modules
1.  **Dashboard**: Live KPI cards, Revenue Trend Line Chart (SVG), Active Cycle Widgets.
2.  **User Management**: List users, Add/Deduct Balance (Withdrawable/Locked), Block/Suspend.
3.  **Game Ops**:
    *   Live Monitor: Real-time pool visualization.
    *   Interventions: Suspend Cycle, Void Cycle (Refund All), Force Result (Pin Protected).
4.  **Merchant Ops**:
    *   Manage Merchants: Add/Remove, Toggle Online, Edit Limits.
    *   Live Orders: View P2P order stream.
    *   Token Pricing: Set Buy/Sell rates.
5.  **Financials**: NGR (Net Gaming Revenue) Calculation, Cash Flow Analysis.
6.  **Security**: 2FA (TOTP) setup using `otpauth` & `qrcode`. Backup codes generation.
7.  **Content**: Mobile Simulator for editing Rules/Promos.

---

## 5. Data Schema (TypeScript Interfaces)

### 5.1 User & Identity
```typescript
interface User {
  id: string;
  mobile: string;
  username: string;
  walletBalance: number;
  lockedBalance: number; // 1:1 Playthrough Rule
  walletAddress: string;
  profilePic?: string;
  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'PENDING_KYC';
  kycStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NONE';
  joinedAt: number;
  lastLogin: number;
}

interface AdminUser {
  id: string;
  username: string;
  role: 'OWNER' | 'ADMIN' | 'MODERATOR';
  permissions: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  backupCodes?: string[];
}
```

### 5.2 Gaming
```typescript
interface GameCycle {
  id: string;
  type: 'FULL_DAY' | '30_MIN';
  startTime: number;
  endTime: number;
  status: 'OPEN' | 'MERGED' | 'CLOSED' | 'RESULT_DECLARED' | 'PAUSED' | 'CANCELLED';
  totalDelhi: number;
  totalBombay: number;
  winner?: 'DELHI' | 'BOMBAY';
  pendingResult?: 'DELHI' | 'BOMBAY'; // Admin Override
  isPaused?: boolean;
}

interface Bet {
  id: string;
  userId: string;
  amount: number;
  side: 'DELHI' | 'BOMBAY';
  cycleId: string;
  timestamp: number;
  status: 'PENDING' | 'WON' | 'LOST' | 'REFUNDED';
}
```

### 5.3 Financials & Merchant
```typescript
interface MerchantProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  isOnline: boolean;
  limits: {
    minDeposit: number;
    maxDeposit: number;
    minWithdraw: number;
    maxWithdraw: number;
  };
  dailyCap: number;
  currentDailyVolume: number;
  totalProcessedVolume: number;
}

interface P2POrder {
  id: string;
  userId: string;
  merchantId: string | null;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  fiatAmount: number; // INR
  rateUsed: number;
  status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED' | ...;
  requiresVideoKYC: boolean; // True if > 20000
  createdAt: number;
}

interface TokenRates {
  buyPrice: number;
  sellPrice: number;
  updatedAt: number;
}
```

---

## 6. Security Protocols
1.  **Pin Protection**: Critical Admin actions (Void Cycle, Force Result) require a PIN (Default: 0000).
2.  **2FA**: Time-based One Time Password (TOTP) required for Admin Login if enabled.
3.  **Race Condition Handling**: `isProcessingBet` Ref used to prevent double-betting on network lag.
4.  **Audit Logs**: All Admin actions are logged to `AuditLog` table with Timestamp, AdminID, Action, and Details.

## 7. Deployment Checklist
1.  Ensure `React.StrictMode` is enabled in `user-panel/src/index.tsx`.
2.  Verify `metadata.json` permissions list is empty (unless camera needed for future KYC).
3.  Ensure `mockBackend` persistence is cleared or seeded correctly for first run.
4.  Verify Error Boundary catches simulated crashes.
5.  Set `VITE_USE_MOCK=false` in environment variables to enable Real API mode.
