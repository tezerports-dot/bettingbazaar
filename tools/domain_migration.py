#!/usr/bin/env python3
"""
domain_migration.py — Betting Bazaar: P2P → Merchant Payment Processing

PHASES
  Phase 0 (core)         Steps 1-26  Original domain migration
  Phase 1 (patches)      Steps 27-32 Complete remaining P2P references
  Phase 2 (architecture) Steps 33-39 Provider interfaces, event bus, feature flags
  Phase 3 (cleanup)      Steps 40-41 Remove .bak files, scan dead files
  Phase 4 (report)       Step  42    Write migration report

Usage:
  python3 tools/domain_migration.py [options]

Options:
  --repo-root PATH    Repository root (default: auto-detect)
  --dry-run           Show changes without writing
  --phase PHASE       One of: core, patches, architecture, cleanup, report, all (default)
  --force             Re-run steps even if state file says completed
  --reset-state       Clear migration state file and start fresh

This script is IDEMPOTENT: safe to run multiple times.
State is saved to tools/.migration-state.json between runs.
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

# ─── ANSI colours ────────────────────────────────────────────────────────────
GREEN  = "\033[32m"
YELLOW = "\033[33m"
RED    = "\033[31m"
CYAN   = "\033[36m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def log_info(msg):    print(f"{CYAN}[INFO]{RESET}  {msg}")
def log_ok(msg):      print(f"{GREEN}[OK]{RESET}    {msg}")
def log_warn(msg):    print(f"{YELLOW}[WARN]{RESET}  {msg}")
def log_error(msg):   print(f"{RED}[ERROR]{RESET} {msg}", file=sys.stderr)
def log_create(msg):  print(f"{GREEN}[CREATE]{RESET} {msg}")
def log_modify(msg):  print(f"{YELLOW}[MODIFY]{RESET} {msg}")
def log_delete(msg):  print(f"{RED}[DELETE]{RESET} {msg}")
def log_skip(msg):    print(f"{CYAN}[SKIP]{RESET}   {msg}")


# ═════════════════════════════════════════════════════════════════════════════
# MIGRATION STATE
# Tracks completed steps across runs so the script can be safely interrupted
# and resumed. State is saved to tools/.migration-state.json.
# ═════════════════════════════════════════════════════════════════════════════

class MigrationState:
    """Persistent state for resumable migrations."""

    def __init__(self, path: Path):
        self.path = path
        self._data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text())
            except Exception:
                return {}
        return {"schema": 2, "completed": [], "failed": {}, "created": datetime.now().isoformat()}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data["last_run"] = datetime.now().isoformat()
        self.path.write_text(json.dumps(self._data, indent=2))

    def is_done(self, name: str) -> bool:
        return name in self._data.get("completed", [])

    def mark_done(self, name: str):
        lst = self._data.setdefault("completed", [])
        if name not in lst:
            lst.append(name)
        # Clear any prior failure for this step
        self._data.get("failed", {}).pop(name, None)
        self._save()

    def mark_failed(self, name: str, error: str):
        self._data.setdefault("failed", {})[name] = {"error": error, "at": datetime.now().isoformat()}
        self._save()

    def reset(self):
        self._data = {"schema": 2, "completed": [], "failed": {}, "created": datetime.now().isoformat()}
        self._save()

    def summary(self) -> str:
        done = len(self._data.get("completed", []))
        fail = len(self._data.get("failed", {}))
        return f"{done} completed, {fail} failed"

    def completed_steps(self) -> list:
        return list(self._data.get("completed", []))


# Global state instance (set in main)
_STATE: MigrationState | None = None


# ─── Summary tracking ─────────────────────────────────────────────────────────
SUMMARY = {"modified": [], "deleted": [], "created": [], "skipped": []}

def record(action, path):
    key = str(path)
    if key not in SUMMARY[action]:
        SUMMARY[action].append(key)


# ─── Step runner ──────────────────────────────────────────────────────────────
def run_step(fn, root: Path, dry_run: bool, force: bool = False):
    """Execute a migration step with state tracking and error isolation."""
    name = fn.__name__
    if not force and _STATE and _STATE.is_done(name):
        log_skip(f"{name}  (done in previous run — use --force to re-run)")
        record("skipped", name)
        return
    try:
        fn(root, dry_run)
        if not dry_run and _STATE:
            _STATE.mark_done(name)
    except Exception as exc:
        if _STATE:
            _STATE.mark_failed(name, str(exc))
        raise


# ─── File helpers ─────────────────────────────────────────────────────────────
def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")

def backup(path: Path, dry_run: bool):
    bak = path.with_suffix(path.suffix + ".bak")
    if not dry_run and not bak.exists():
        shutil.copy2(path, bak)

def write_file(path: Path, content: str, dry_run: bool, label: str = ""):
    tag = label or str(path)
    if path.exists():
        if read_file(path) == content:
            return
        backup(path, dry_run)
        if not dry_run:
            path.write_text(content, encoding="utf-8")
        log_modify(tag)
        record("modified", path)
    else:
        if not dry_run:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        log_create(tag)
        record("created", path)

def delete_file(path: Path, dry_run: bool):
    if not path.exists():
        return
    backup(path, dry_run)
    if not dry_run:
        path.unlink()
    log_delete(str(path))
    record("deleted", path)

def patch_file(path: Path, replacements: list, dry_run: bool):
    if not path.exists():
        log_warn(f"patch_file: {path} not found — skip")
        return
    content = read_file(path)
    original = content
    for old, new in replacements:
        content = content.replace(old, new)
    if content != original:
        write_file(path, content, dry_run)

def regex_patch_file(path: Path, replacements: list, dry_run: bool):
    if not path.exists():
        log_warn(f"regex_patch: {path} not found — skip")
        return
    content = read_file(path)
    original = content
    for pattern, repl in replacements:
        content = re.sub(pattern, repl, content)
    if content != original:
        write_file(path, content, dry_run)


# ─── Governance header ────────────────────────────────────────────────────────
GOV = "// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)\n"


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Core Domain Migration
# Original 26-step migration: P2P model/route/type replacement.
# ═════════════════════════════════════════════════════════════════════════════

P2P_ONLY_FILES = [
    "backend/routes/p2p.routes.js",
    "backend/models/chat.model.js",
    "services/p2pStateMachine.ts",
]

def step_delete_p2p_files(root: Path, dry_run: bool):
    log_info("P0-01 — Deleting pure P2P-only files")
    for rel in P2P_ONLY_FILES:
        delete_file(root / rel, dry_run)

def step_create_payment_order_model(root: Path, dry_run: bool):
    log_info("P0-02 — Creating paymentOrder.model.js")
    dest = root / "backend/models/paymentOrder.model.js"
    if dest.exists():
        log_skip("paymentOrder.model.js already exists")
        return
    write_file(dest, _PAYMENT_ORDER_MODEL, dry_run)

def step_create_payment_service(root: Path, dry_run: bool):
    log_info("P0-03 — Creating paymentProcessing.service.js")
    dest = root / "backend/services/paymentProcessing.service.js"
    if dest.exists():
        log_skip("paymentProcessing.service.js already exists")
        return
    write_file(dest, _PAYMENT_SERVICE, dry_run)

def step_create_payment_routes(root: Path, dry_run: bool):
    log_info("P0-04 — Creating payment.routes.js")
    dest = root / "backend/routes/payment.routes.js"
    if dest.exists():
        log_skip("payment.routes.js already exists")
        return
    write_file(dest, _PAYMENT_ROUTES, dry_run)

def step_patch_models_index(root: Path, dry_run: bool):
    log_info("P0-05 — Patching models/index.js")
    path = root / "backend/models/index.js"
    patch_file(path, [
        ("export * from './p2pOrder.model.js';\n", ""),
        ("export * from './chat.model.js';\n", ""),
    ], dry_run)
    if path.exists():
        content = read_file(path)
        if "paymentOrder.model.js" not in content:
            new_content = content.replace(
                "export * from './merchant.model.js';",
                "export * from './merchant.model.js';\nexport * from './paymentOrder.model.js';"
            )
            if new_content != content:
                write_file(path, new_content, dry_run)

def step_patch_server_js(root: Path, dry_run: bool):
    log_info("P0-06 — Patching server.js")
    path = root / "backend/server.js"
    patch_file(path, [
        ("import p2pRoutes          from './routes/p2p.routes.js';", "import paymentRoutes      from './routes/payment.routes.js';"),
        ("import p2pRoutes from './routes/p2p.routes.js';", "import paymentRoutes from './routes/payment.routes.js';"),
    ], dry_run)
    regex_patch_file(path, [
        (r"app\.use\(['\"]\/api\/p2p['\"],\s*p2pRoutes\)", "app.use('/api/payment', paymentRoutes)"),
        (r"app\.use\(['\"]\/api\/p2p['\"],\s*paymentRoutes\)", "app.use('/api/payment', paymentRoutes)"),
    ], dry_run)

def step_patch_cron_jobs(root: Path, dry_run: bool):
    log_info("P0-07 — Patching cronJobs.js")
    path = root / "backend/startup/cronJobs.js"
    if not path.exists():
        return
    patch_file(path, [
        ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
        ("const P2POrder", "const PaymentOrder"),
    ], dry_run)

def step_patch_admin_routes(root: Path, dry_run: bool):
    log_info("P0-08 — Patching admin routes (P2POrder → PaymentOrder)")
    files = [
        "backend/routes/admin/queue.admin.routes.js",
        "backend/routes/admin/disputeResolution.admin.routes.js",
        "backend/routes/admin/utr.admin.routes.js",
        "backend/routes/admin/analytics.admin.routes.js",
        "backend/routes/admin/users.admin.routes.js",
        "backend/routes/admin/merchants.admin.routes.js",
        "backend/routes/admin/_adminShared.js",
        "backend/services/admin.service.js",
        "backend/services/wallet.service.js",
        "backend/services/walletAuthority.service.js",
        "backend/middleware/order-crypto-access.js",
        "backend/migrations/002-fix-everything.js",
        "backend/migrations/001-add-dual-balance-fields.js",
    ]
    replacements = [
        ("mongoose.model('P2POrder')",   "mongoose.model('PaymentOrder')"),
        ('mongoose.model("P2POrder")',   'mongoose.model("PaymentOrder")'),
        ("getModels().P2POrder",         "getModels().PaymentOrder"),
        ("{ P2POrder }",                 "{ PaymentOrder }"),
        ("P2POrder.find(",               "PaymentOrder.find("),
        ("P2POrder.findOne(",            "PaymentOrder.findOne("),
        ("P2POrder.create(",             "PaymentOrder.create("),
        ("P2POrder.countDocuments(",     "PaymentOrder.countDocuments("),
        ("P2POrder.aggregate(",          "PaymentOrder.aggregate("),
        ("ref: 'P2POrder'",              "ref: 'PaymentOrder'"),
        ('ref: "P2POrder"',              'ref: "PaymentOrder"'),
        ("model: 'P2POrder'",            "model: 'PaymentOrder'"),
        ('model: "P2POrder"',            'model: "PaymentOrder"'),
        ("new P2POrder(",                "new PaymentOrder("),
        ("const P2POrder =",             "const PaymentOrder ="),
        ("'P2P queue'",                  "'Payment queue'"),
        ("P2P queue",                    "Payment queue"),
        ("'p2p-queue'",                  "'payment-queue'"),
        ("/p2p-queue",                   "/payment-queue"),
    ]
    for rel in files:
        patch_file(root / rel, replacements, dry_run)
    shared = root / "backend/routes/admin/_adminShared.js"
    if shared.exists():
        patch_file(shared, [
            ("P2POrder:  mongoose.model('P2POrder')", "PaymentOrder: mongoose.model('PaymentOrder')"),
            ("P2POrder: mongoose.model('P2POrder')",  "PaymentOrder: mongoose.model('PaymentOrder')"),
            ('P2POrder:  mongoose.model("P2POrder")', 'PaymentOrder: mongoose.model("PaymentOrder")'),
        ], dry_run)

def step_patch_merchant_routes(root: Path, dry_run: bool):
    log_info("P0-09 — Patching merchant.routes.js")
    patch_file(root / "backend/routes/merchant.routes.js", [
        ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
        ("const P2POrder",             "const PaymentOrder"),
        ("new P2POrder(",              "new PaymentOrder("),
        ("P2POrder.find(",             "PaymentOrder.find("),
        ("P2POrder.findOne(",          "PaymentOrder.findOne("),
        ("P2POrder.countDocuments(",   "PaymentOrder.countDocuments("),
    ], dry_run)

def step_patch_frontend_types(root: Path, dry_run: bool):
    log_info("P0-10 — Patching types.ts")
    path = root / "types.ts"
    if not path.exists():
        return
    content = read_file(path)
    content = re.sub(r'export interface P2POrder \{.*?\}\n\nexport interface TokenRates \{.*?\}\n', '', content, flags=re.DOTALL)
    content = re.sub(r'export interface P2POrder \{.*?\}\n', '', content, flags=re.DOTALL)
    content = re.sub(r'export interface TokenRates \{.*?\}\n', '', content, flags=re.DOTALL)
    if 'PaymentOrder' not in content:
        content = content.rstrip() + "\n" + _PAYMENT_ORDER_TYPES
    write_file(path, content, dry_run)

def step_create_payment_state_machine(root: Path, dry_run: bool):
    log_info("P0-11 — Creating paymentStateMachine.ts")
    dest = root / "services/paymentStateMachine.ts"
    if dest.exists():
        log_skip("paymentStateMachine.ts already exists")
        return
    write_file(dest, _PAYMENT_STATE_MACHINE, dry_run)

def step_patch_wallet_modal(root: Path, dry_run: bool):
    log_info("P0-12 — Patching WalletModal.tsx")
    path = root / "components/Modals/WalletModal.tsx"
    patch_file(path, [
        ("from '../../services/p2pStateMachine'",  "from '../../services/paymentStateMachine'"),
        ("from '../services/p2pStateMachine'",      "from '../services/paymentStateMachine'"),
        ("'/api/p2p/deposit/create'",               "'/api/payment/deposit/create'"),
        ("'/api/p2p/withdrawal/create'",            "'/api/payment/withdrawal/create'"),
        ("'/api/p2p/order/",                        "'/api/payment/order/"),
        ("`/api/p2p/order/${",                      "`/api/payment/order/${"),
        ("P2P_STATE_LABELS",                        "PAYMENT_STATE_LABELS"),
        ("type P2PState",                           "type PaymentOrderState"),
        ("P2PState",                                "PaymentOrderState"),
    ], dry_run)

def step_patch_frontend_files(root: Path, dry_run: bool):
    log_info("P0-13 — Patching frontend files (API paths + type refs)")
    files = [
        "services/realBackend.ts",
        "services/backend.interface.ts",
        "services/GameContext.tsx",
        "services/walletTransactionDTO.ts",
        "pages/HistoryPage.tsx",
        "pages/GamePage.tsx",
        "MerchantApp.tsx",
        "admin-panel/src/Pages/Payment/PaymentControlCenter.tsx",
        "admin-panel/src/Pages/Disputes/DisputeManager.tsx",
        "admin-panel/src/Pages/QueueManager/QueueDashboard.tsx",
        "admin-panel/src/Pages/Merchants/MerchantsList.tsx",
        "admin-panel/src/services/api.ts",
        "admin-panel/src/types.ts",
        "admin-panel/src/utils/permissions.ts",
        "admin-panel/src/hooks/usePermission.ts",
        "merchant-panel/src/pages/OrderManagement.tsx",
        "merchant-panel/src/pages/BulkPayouts.tsx",
        "merchant-panel/src/components/OrderCard.tsx",
        "merchant-panel/src/services/api.ts",
        "merchant-panel/src/services/sse.ts",
        "merchant-panel/src/types.ts",
    ]
    replacements = [
        ("/api/p2p/deposit/create",    "/api/payment/deposit/create"),
        ("/api/p2p/withdrawal/create", "/api/payment/withdrawal/create"),
        ("/api/p2p/order/",            "/api/payment/order/"),
        ("/api/p2p/orders",            "/api/payment/orders"),
        ("/api/p2p/rates",             "/api/payment/rates"),
        ("/api/p2p/",                  "/api/payment/"),
        ("P2POrder",                   "PaymentOrder"),
        ("P2PState",                   "PaymentOrderState"),
        ("P2P_STATE_LABELS",           "PAYMENT_STATE_LABELS"),
        ("P2P_STATE_COLOR",            "PAYMENT_STATE_COLOR"),
        ("P2P_STATES",                 "PAYMENT_STATES"),
        ("p2pStateMachine",            "paymentStateMachine"),
        ("createP2POrder",             "createPaymentOrder"),
        ("getUserOrders",              "getUserPaymentOrders"),
        ("P2P order",                  "payment order"),
        ("P2P Order",                  "Payment Order"),
        ("P2P queue",                  "payment queue"),
        ("P2P Queue",                  "Payment Queue"),
    ]
    for rel in files:
        p = root / rel
        if p.exists():
            patch_file(p, replacements, dry_run)
    admin_types = root / "admin-panel/src/types.ts"
    if admin_types.exists():
        content = read_file(admin_types)
        content = content.replace("interface P2POrder", "interface PaymentOrder")
        content = content.replace("type P2POrder =", "type PaymentOrder =")
        write_file(admin_types, content, dry_run)

def step_patch_backend_interface(root: Path, dry_run: bool):
    log_info("P0-14 — Patching backend.interface.ts")
    patch_file(root / "services/backend.interface.ts", [
        ("createP2POrder(",          "createPaymentOrder("),
        ("getUserOrders(",           "getUserPaymentOrders("),
        ("getAllOrders(",            "getAllPaymentOrders("),
        ("getMerchantOrders(",       "getMerchantPaymentOrders("),
        ("updateOrderStatus(",       "updatePaymentOrderStatus("),
        ("assignOrderToMerchant(",   "assignPaymentOrderToMerchant("),
        ("// Chat & Files",         "// Files"),
        ("P2POrder",                "PaymentOrder"),
        ("P2PState",                "PaymentOrderState"),
    ], dry_run)

def step_patch_real_backend(root: Path, dry_run: bool):
    log_info("P0-15 — Patching realBackend.ts")
    patch_file(root / "services/realBackend.ts", [
        ("/api/p2p/",         "/api/payment/"),
        ("createP2POrder",    "createPaymentOrder"),
        ("getUserOrders",     "getUserPaymentOrders"),
        ("getAllOrders",      "getAllPaymentOrders"),
        ("getMerchantOrders", "getMerchantPaymentOrders"),
        ("P2POrder",         "PaymentOrder"),
    ], dry_run)

def step_patch_wallet_dto(root: Path, dry_run: bool):
    log_info("P0-16 — Patching walletTransactionDTO.ts")
    patch_file(root / "services/walletTransactionDTO.ts", [
        ("P2POrder", "PaymentOrder"),
        ("P2PState", "PaymentOrderState"),
    ], dry_run)

def step_patch_merchant_panel(root: Path, dry_run: bool):
    log_info("P0-17 — Patching merchant panel")
    files = [
        "merchant-panel/src/constants.ts",
        "merchant-panel/src/App.tsx",
        "merchant-panel/src/pages/Dashboard.tsx",
        "merchant-panel/src/pages/HistoryViews.tsx",
        "merchant-panel/src/pages/ProfileSettings.tsx",
        "merchant-panel/src/services/AuthContext.tsx",
    ]
    replacements = [
        ("/api/p2p/", "/api/payment/"),
        ("P2POrder",  "PaymentOrder"),
        ("P2PState",  "PaymentOrderState"),
    ]
    for rel in files:
        p = root / rel
        if p.exists():
            patch_file(p, replacements, dry_run)

def step_patch_admin_queue_dashboard(root: Path, dry_run: bool):
    log_info("P0-18 — Patching admin queue dashboard")
    patch_file(root / "admin-panel/src/Pages/QueueManager/QueueDashboard.tsx", [
        ("/api/admin/p2p-queue",   "/api/admin/payment-queue"),
        ("/api/admin/p2p-orders/", "/api/admin/payment-orders/"),
        ("P2POrder",               "PaymentOrder"),
        ("P2PState",               "PaymentOrderState"),
        ("p2p_order",              "payment_order"),
        ("P2P order",              "payment order"),
    ], dry_run)
    queue_route = root / "backend/routes/admin/queue.admin.routes.js"
    patch_file(queue_route, [
        ("router.get('/p2p-queue'",          "router.get('/payment-queue'"),
        ("router.post('/p2p-orders/",        "router.post('/payment-orders/"),
        ("router.get('/p2p-orders/",         "router.get('/payment-orders/"),
        ("router.put('/p2p-orders/",         "router.put('/payment-orders/"),
        ("GET /api/admin/p2p-queue",         "GET /api/admin/payment-queue"),
        ("POST /api/admin/p2p-orders",       "POST /api/admin/payment-orders"),
        ("mongoose.model('P2POrder')",       "mongoose.model('PaymentOrder')"),
        ("P2POrder.find(",                   "PaymentOrder.find("),
        ("P2POrder.findOne(",                "PaymentOrder.findOne("),
        ("P2POrder.aggregate(",              "PaymentOrder.aggregate("),
        ("P2POrder.countDocuments(",         "PaymentOrder.countDocuments("),
        ("new P2POrder(",                    "new PaymentOrder("),
        ("Failed to fetch P2P queue",        "Failed to fetch payment queue"),
    ], dry_run)

def step_patch_upload_routes(root: Path, dry_run: bool):
    log_info("P0-19 — Patching upload.routes.js")
    patch_file(root / "backend/routes/upload.routes.js", [
        ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
        ("P2POrder",                   "PaymentOrder"),
    ], dry_run)

def step_patch_sse_routes(root: Path, dry_run: bool):
    log_info("P0-20 — Patching sse.routes.js")
    patch_file(root / "backend/routes/sse.routes.js", [
        ("P2POrder", "PaymentOrder"),
        ("p2p_chat", ""),
        ("chat_",    ""),
    ], dry_run)

def step_patch_socket_handlers(root: Path, dry_run: bool):
    log_info("P0-21 — Patching socketHandlers.js (remove P2P chat handlers)")
    path = root / "backend/startup/socketHandlers.js"
    if not path.exists():
        return
    content = read_file(path)
    original = content
    for pat in [
        r"socket\.on\(['\"]join_order_room['\"].*?\}\);\n",
        r"socket\.on\(['\"]leave_order_room['\"].*?\}\);\n",
        r"socket\.on\(['\"]send_chat['\"].*?\}\);\n",
        r"socket\.on\(['\"]chat_message['\"].*?\}\);\n",
    ]:
        content = re.sub(pat, "", content, flags=re.DOTALL)
    content = content.replace("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')")
    if content != original:
        write_file(path, content, dry_run)

def step_patch_dispute_routes(root: Path, dry_run: bool):
    log_info("P0-22 — Patching disputeResolution.admin.routes.js")
    patch_file(root / "backend/routes/admin/disputeResolution.admin.routes.js", [
        ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
        ("const P2POrder",             "const PaymentOrder"),
        ("{ P2POrder }",               "{ PaymentOrder }"),
        ("P2POrder.find(",             "PaymentOrder.find("),
        ("P2POrder.findOne(",          "PaymentOrder.findOne("),
        ("P2POrder.aggregate(",        "PaymentOrder.aggregate("),
        ("new P2POrder(",              "new PaymentOrder("),
        ("ref: 'P2POrder'",            "ref: 'PaymentOrder'"),
    ], dry_run)

def step_patch_wallet_services(root: Path, dry_run: bool):
    log_info("P0-23 — Patching wallet services")
    for rel in ["backend/services/wallet.service.js", "backend/services/walletAuthority.service.js"]:
        patch_file(root / rel, [
            ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
            ("P2POrder",                   "PaymentOrder"),
            ("ref: 'P2POrder'",            "ref: 'PaymentOrder'"),
        ], dry_run)

def step_patch_auth_middleware(root: Path, dry_run: bool):
    log_info("P0-24 — Patching auth.middleware.js")
    patch_file(root / "backend/middleware/auth.middleware.js", [
        ("mongoose.model('P2POrder')", "mongoose.model('PaymentOrder')"),
        ("P2POrder",                   "PaymentOrder"),
    ], dry_run)

def step_ensure_governance_headers(root: Path, dry_run: bool):
    log_info("P0-25 — Ensuring governance headers on new backend files")
    for rel in [
        "backend/models/paymentOrder.model.js",
        "backend/services/paymentProcessing.service.js",
        "backend/routes/payment.routes.js",
    ]:
        path = root / rel
        if path.exists():
            content = read_file(path)
            if not content.startswith("// GOVERNANCE"):
                write_file(path, GOV + content, dry_run)

_MUST_REPLACE = [
    (re.compile(r"\bP2POrder\b"),             "PaymentOrder"),
    (re.compile(r"['\"]\\/api\\/p2p\\/"),     "'/api/payment/"),
    (re.compile(r"`\\/api\\/p2p\\/"),         "`/api/payment/"),
    (re.compile(r"p2pRoutes"),                "paymentRoutes"),
    (re.compile(r"p2pStateMachine"),          "paymentStateMachine"),
]

def step_safety_sweep(root: Path, dry_run: bool):
    log_info("P0-26 — Safety sweep: remaining P2P references")
    extensions = {".js", ".ts", ".tsx", ".jsx"}
    skip_dirs  = {"node_modules", ".git", "dist", "build", "tools"}
    skip_names = {"paymentOrder.model.js", "paymentProcessing.service.js",
                  "payment.routes.js", "paymentStateMachine.ts", "domain_migration.py"}
    deleted_abs = {str(root / rel) for rel in P2P_ONLY_FILES}

    swept = 0
    for fpath in root.rglob("*"):
        if fpath.is_dir():
            continue
        if any(sd in fpath.parts for sd in skip_dirs):
            continue
        if fpath.suffix not in extensions:
            continue
        if fpath.name.endswith(".bak") or fpath.name in skip_names:
            continue
        if str(fpath) in deleted_abs:
            continue
        try:
            content = read_file(fpath)
            original = content
            for pattern, repl in _MUST_REPLACE:
                content = pattern.sub(repl, content)
            if content != original:
                write_file(fpath, content, dry_run)
                swept += 1
        except Exception as exc:
            log_warn(f"Safety sweep: {fpath} — {exc}")
    log_info(f"Safety sweep patched {swept} additional file(s)")


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 1 — Complete Missing Patches
# Files the 26-step core pass couldn't fully cover.
# ═════════════════════════════════════════════════════════════════════════════

def p1_01_delete_legacy_p2p_model(root: Path, dry_run: bool):
    """Delete backend/models/p2pOrder.model.js — superseded by paymentOrder.model.js."""
    log_info("P1-01 — Deleting legacy p2pOrder.model.js")
    delete_file(root / "backend/models/p2pOrder.model.js", dry_run)

def p1_02_patch_validation_schema(root: Path, dry_run: bool):
    """Rename `p2pOrder` Zod schema key to `paymentOrder` in validation.js."""
    log_info("P1-02 — Patching validation.js Zod schema (p2pOrder → paymentOrder)")
    patch_file(root / "backend/middleware/validation.js", [
        ("p2pOrder: z.object({", "paymentOrder: z.object({"),
    ], dry_run)

def p1_03_patch_wallet_page(root: Path, dry_run: bool):
    """Fix WalletPage.tsx: rename p2pOrders state variable and 'p2p' tab key."""
    log_info("P1-03 — Patching WalletPage.tsx (p2pOrders → paymentOrders, tab 'p2p' → 'payments')")
    path = root / "pages/WalletPage.tsx"
    patch_file(path, [
        # Tab key type union
        ("'overview' | 'ledger' | 'p2p'",                "'overview' | 'ledger' | 'payments'"),
        # State variable
        ("const [p2pOrders, setP2pOrders]",               "const [paymentOrders, setPaymentOrders]"),
        ("setP2pOrders(",                                  "setPaymentOrders("),
        # All usages of the state variable
        ("p2pOrders.filter(",                             "paymentOrders.filter("),
        ("p2pOrders.length",                              "paymentOrders.length"),
        ("p2pOrders.map(",                                "paymentOrders.map("),
        # Tab label / route strings
        ("['p2p','Payment Orders']",                      "['payments','Payment Orders']"),
        ("['p2p', 'Payment Orders']",                     "['payments', 'Payment Orders']"),
        ("tab === 'p2p'",                                  "tab === 'payments'"),
        # Any remaining string 'p2p' used as a route/tab key
        ("'p2p'",                                         "'payments'"),
    ], dry_run)

def p1_04_strip_p2p_state_machine_aliases(root: Path, dry_run: bool):
    """Remove backward-compat P2P re-exports from paymentStateMachine.ts.
    Phase 0 already migrated all consumers; aliases are now dead code."""
    log_info("P1-04 — Removing P2P aliases from paymentStateMachine.ts")
    path = root / "services/paymentStateMachine.ts"
    if not path.exists():
        return
    content = read_file(path)
    # Remove the backward-compat block
    aliases_block = re.compile(
        r'\n// ── Backward-compat aliases.*?export const P2P_STATE_COLOR\s*=\s*PAYMENT_STATE_COLOR;\n',
        re.DOTALL
    )
    new_content = aliases_block.sub("\n", content)
    # Also remove any lingering single-line P2P exports
    new_content = re.sub(r'^export const P2P_STATES\b.*\n', '', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^export type  P2PState\b.*\n', '', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^export const P2P_STATE_LABELS\b.*\n', '', new_content, flags=re.MULTILINE)
    new_content = re.sub(r'^export const P2P_STATE_COLOR\b.*\n', '', new_content, flags=re.MULTILINE)
    if new_content != content:
        write_file(path, new_content, dry_run)

def p1_05_strip_p2p_order_alias(root: Path, dry_run: bool):
    """Remove `export const P2POrder = PaymentOrder` alias from paymentOrder.model.js.
    All consumers are migrated; the alias is now dead code and a P2P reference."""
    log_info("P1-05 — Removing P2POrder alias from paymentOrder.model.js")
    path = root / "backend/models/paymentOrder.model.js"
    if not path.exists():
        return
    content = read_file(path)
    # Remove the backward-compat alias export and its comment
    content = re.sub(
        r'\n// Backward-compat alias.*?export const P2POrder = PaymentOrder;\n',
        '\n',
        content, flags=re.DOTALL
    )
    content = re.sub(r'^export const P2POrder = PaymentOrder;\n', '', content, flags=re.MULTILINE)
    # Remove stale comment block referencing P2POrder alias
    content = re.sub(
        r'\n// Aliases exported for zero-impact migration:.*?call-sites are updated\)\)\n',
        '\n',
        content, flags=re.DOTALL
    )
    write_file(path, content, dry_run)

def p1_06_remove_legacy_redirect_shim(root: Path, dry_run: bool):
    """Remove the /api/p2p/ → /api/payment/ redirect shim from payment.routes.js.
    Clients have been updated; the 308 redirect is dead code."""
    log_info("P1-06 — Removing legacy /api/p2p/ redirect shim from payment.routes.js")
    path = root / "backend/routes/payment.routes.js"
    if not path.exists():
        return
    content = read_file(path)
    # Remove the legacy redirect block
    content = re.sub(
        r'\n// ── Legacy /p2p/\* redirect shim.*?router\.all\(\'\*\', legacyRedirect\(\)\);\n',
        '\n',
        content, flags=re.DOTALL
    )
    # Remove any standalone legacyRedirect references
    content = re.sub(r'\nconst legacyRedirect = .*?\n', '\n', content, flags=re.DOTALL)
    write_file(path, content, dry_run)


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 2 — Architecture Extension Points
# Provider interfaces, event bus, feature flags.
# "Every new provider must plug into interfaces without changing existing logic."
# ═════════════════════════════════════════════════════════════════════════════

_PAYMENT_PROVIDER_INTERFACE = GOV + '''\
/**
 * PaymentProvider.interface.js — Base class for all payment gateway integrations.
 *
 * HOW TO ADD A NEW PROVIDER
 * ─────────────────────────
 * 1. Create backend/providers/payment/<name>/<Name>Provider.js
 * 2. Extend PaymentProvider and implement every method.
 * 3. Register at startup: providerRegistry.register(new YourProvider());
 * 4. No changes to business logic or existing routes required.
 *
 * SUPPORTED PROVIDER TYPES
 *   Domestic UPI/IMPS  — current merchant provider (already live)
 *   International      — Stripe, Razorpay international, etc.
 *   Crypto             — future
 *   UPI aggregator     — future
 */

export class PaymentProvider {
  /** Unique snake_case identifier, e.g. 'merchant_upi', 'stripe_intl' */
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  get version()     { return '1.0.0'; }
  /** Currencies this provider accepts, e.g. ['INR'], ['USD','EUR'] */
  get currencies()  { return ['INR']; }

  /** @returns {Promise<boolean>} */
  async isAvailable()  { return true; }
  /** @returns {Promise<{ok: boolean, latencyMs?: number}>} */
  async healthCheck()  { return { ok: true }; }

  /**
   * Called when a user initiates a DEPOSIT.
   * Return enough data for the UI to show payment instructions.
   * @param {object} order  PaymentOrder document
   * @returns {Promise<{sessionId: string, instructions: object}>}
   */
  async createDepositSession(order) {
    throw new Error(`${this.constructor.name}: createDepositSession not implemented`);
  }

  /**
   * Verify a payment reference against provider records.
   * @param {string} reference  UTR, transaction ID, etc.
   * @param {number} amount     Expected amount in minor units
   * @param {string} currency
   * @returns {Promise<{verified: boolean, providerRef?: string}>}
   */
  async verifyPayment(reference, amount, currency = 'INR') {
    throw new Error(`${this.constructor.name}: verifyPayment not implemented`);
  }

  /**
   * Initiate a WITHDRAWAL / merchant payout.
   * @param {object} order  PaymentOrder document
   * @returns {Promise<{providerRef: string, eta?: Date}>}
   */
  async initiateWithdrawal(order) {
    throw new Error(`${this.constructor.name}: initiateWithdrawal not implemented`);
  }

  /**
   * Validate and parse an incoming webhook payload.
   * @param {Buffer|object} payload
   * @param {string}        signature  From provider request headers
   * @param {string}        secret     From environment config
   * @returns {Promise<{event: string, orderId: string, status: string}>}
   */
  async handleWebhook(payload, signature, secret) {
    throw new Error(`${this.constructor.name}: handleWebhook not implemented`);
  }
}
'''

_PROVIDER_REGISTRY = GOV + '''\
/**
 * registry.js — PaymentProvider and CasinoProvider registry.
 *
 * Register providers at startup in server.js or a dedicated bootstrap file:
 *
 *   import { providerRegistry } from './providers/registry.js';
 *   import { MerchantUPIProvider } from './providers/payment/merchant/MerchantUPIProvider.js';
 *   providerRegistry.payment.register(new MerchantUPIProvider());
 *
 * Access anywhere without coupling to a specific implementation:
 *
 *   const provider = providerRegistry.payment.get('merchant_upi');
 *   const result   = await provider.createDepositSession(order);
 */

function makeRegistry(label) {
  const _map = new Map();
  return {
    register(provider) {
      if (!provider.id) throw new Error(`${label} provider missing .id`);
      _map.set(provider.id, provider);
      console.info(`[registry] ${label} provider registered: ${provider.id} v${provider.version}`);
    },
    get(id) {
      const p = _map.get(id);
      if (!p) throw new Error(`${label} provider '${id}' not registered. Available: [${[..._map.keys()].join(', ')}]`);
      return p;
    },
    getAvailable() {
      return [..._map.values()].filter(p => p.isAvailable?.() !== false);
    },
    all()  { return [..._map.values()]; },
    ids()  { return [..._map.keys()]; },
    has(id){ return _map.has(id); },
  };
}

export const providerRegistry = {
  payment:    makeRegistry('Payment'),
  casino:     makeRegistry('Casino'),
  sportsbook: makeRegistry('Sportsbook'),
};
'''

_CASINO_PROVIDER_INTERFACE = GOV + '''\
/**
 * CasinoProvider.interface.js — Base class for live casino integrations.
 *
 * HOW TO ADD A NEW CASINO PROVIDER
 * ──────────────────────────────────
 * 1. Create backend/providers/casino/<name>/<Name>Provider.js
 * 2. Extend CasinoProvider and implement all abstract methods.
 * 3. Register: providerRegistry.casino.register(new EvolutionProvider());
 * 4. Gate behind feature flag: isEnabled('LIVE_CASINO')
 *
 * SUPPORTED PROVIDERS (implement CasinoProvider for each)
 *   Evolution Gaming  — https://www.evolution.com/
 *   Pragmatic Play    — https://pragmaticplaylive.net/
 *   EZUGI             — https://ezugi.com/
 *   Vivo Gaming       — https://www.vivogaming.com/
 *   TVBet             — https://tvbet.tv/
 */

export class CasinoProvider {
  /** Unique snake_case ID, e.g. 'evolution', 'pragmatic', 'ezugi' */
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  /** 'live' | 'slots' | 'table' | 'fishing' | 'scratch' */
  get type()        { return 'live'; }
  get version()     { return '1.0.0'; }

  /** Disabled by default — enable after integration testing */
  async isAvailable() { return false; }

  /**
   * Authenticate a player and return a provider session token.
   * @param {string} userId    Platform user ID
   * @param {string} currency  e.g. 'INR'
   * @returns {Promise<{token: string, expiresAt: Date}>}
   */
  async authenticate(userId, currency = 'INR') {
    throw new Error(`${this.constructor.name}: authenticate not implemented`);
  }

  /**
   * Return a launch URL for the lobby or a specific game.
   * @param {string}      userId
   * @param {string|null} gameId  Null = full lobby
   * @param {object}      options  { mode: 'real'|'demo', language: 'en', ... }
   * @returns {Promise<{url: string, expiresAt: Date}>}
   */
  async getLobbyUrl(userId, gameId = null, options = {}) {
    throw new Error(`${this.constructor.name}: getLobbyUrl not implemented`);
  }

  /**
   * Get the player's balance on this provider's wallet.
   * @returns {Promise<{balance: number, currency: string}>}
   */
  async getBalance(userId) {
    throw new Error(`${this.constructor.name}: getBalance not implemented`);
  }

  /**
   * Handle provider callbacks (bet results, session close, etc.).
   * Called by the casino webhook route.
   * @param {object} payload  Provider-specific JSON
   * @param {object} headers  Request headers (for signature validation)
   * @returns {Promise<{accepted: boolean}>}
   */
  async handleCallback(payload, headers = {}) {
    throw new Error(`${this.constructor.name}: handleCallback not implemented`);
  }

  /**
   * List available games for lobby rendering.
   * @param {string|null} category  e.g. 'live_roulette', 'live_blackjack'
   * @returns {Promise<Array<{id: string, name: string, thumbnail: string}>>}
   */
  async listGames(category = null) {
    throw new Error(`${this.constructor.name}: listGames not implemented`);
  }
}
'''

_SPORTSBOOK_PROVIDER_INTERFACE = GOV + '''\
/**
 * SportsbookProvider.interface.js — Base class for sportsbook/odds integrations.
 *
 * HOW TO ADD A NEW ODDS PROVIDER
 * ───────────────────────────────
 * 1. Create backend/providers/sportsbook/<name>/<Name>Provider.js
 * 2. Extend SportsbookProvider and implement all abstract methods.
 * 3. Register: providerRegistry.sportsbook.register(new BetfairProvider());
 * 4. Gate behind feature flag: isEnabled('SPORTSBOOK')
 */

export class SportsbookProvider {
  get id()          { throw new Error(`${this.constructor.name}: id not implemented`); }
  get displayName() { return this.id; }
  get version()     { return '1.0.0'; }

  /** Disabled by default */
  async isAvailable() { return false; }

  /**
   * Fetch upcoming / live events.
   * @param {string}   sport     e.g. 'cricket', 'football'
   * @param {string}   league    e.g. 'ipl', 'epl'
   * @param {Date}     fromDate
   * @param {Date}     toDate
   * @returns {Promise<Array<{id: string, name: string, startTime: Date, status: string}>>}
   */
  async getEvents(sport, league, fromDate, toDate) {
    throw new Error(`${this.constructor.name}: getEvents not implemented`);
  }

  /**
   * Fetch current odds for an event.
   * @param {string} eventId
   * @returns {Promise<Array<{market: string, selections: Array<{name: string, odds: number}>}>>}
   */
  async getOdds(eventId) {
    throw new Error(`${this.constructor.name}: getOdds not implemented`);
  }

  /**
   * Subscribe to real-time odds updates.
   * Implementation should use SSE, WebSocket, or polling as appropriate.
   * @param {string[]}  eventIds
   * @param {function}  callback  ({ eventId, market, selections, ts }) => void
   * @returns {Promise<{unsubscribe: function}>}
   */
  async subscribeToOddsUpdates(eventIds, callback) {
    throw new Error(`${this.constructor.name}: subscribeToOddsUpdates not implemented`);
  }

  /**
   * Settle a placed bet against the final result.
   * @param {string} betId
   * @param {object} result  { winner: string, score: object }
   * @returns {Promise<{settled: boolean, payout: number}>}
   */
  async settleBet(betId, result) {
    throw new Error(`${this.constructor.name}: settleBet not implemented`);
  }
}
'''

_EVENT_BUS_SERVICE = GOV + '''\
/**
 * eventBus.service.js — Internal domain event bus.
 *
 * ARCHITECTURE
 * ─────────────
 *   HTTP requests  → route handlers (commands)
 *   Domain events  → eventBus.publish()  (this file)
 *   Realtime push  → sseManager.service.js  (one-way server → client)
 *   External push  → webhooks (client → server)
 *   Bidirectional  → Socket.IO (game broadcasts, future public chat)
 *
 * FUTURE SWAP (zero call-site changes required)
 *   Replace EventEmitter with Kafka:      swap publish/subscribe implementations
 *   Replace with NATS:                    same swap pattern
 *   Replace with Redis Streams:           same swap pattern
 *   Enable CQRS:                          commands stay in route handlers,
 *                                         projections subscribe to events here
 *
 * USAGE
 *   import { publish, subscribe, EVENTS } from '../services/eventBus.service.js';
 *
 *   // Emit after a payment order completes:
 *   publish(EVENTS.PAYMENT_ORDER_COMPLETED, { orderId, userId, amount });
 *
 *   // React to the event anywhere in the codebase:
 *   subscribe(EVENTS.PAYMENT_ORDER_COMPLETED, ({ payload }) => {
 *     emitWalletUpdate(payload.userId);
 *   });
 */

import { EventEmitter } from 'events';

const _bus = new EventEmitter();
_bus.setMaxListeners(200); // allow many subscribers across domains

// ── Event catalog ─────────────────────────────────────────────────────────────
// ALL domain events must be declared here.
// Consumers import EVENTS.* — never use raw string literals.
export const EVENTS = Object.freeze({

  // ── Payment domain ────────────────────────────────────────────────────────
  PAYMENT_ORDER_CREATED:    'payment.order.created',
  PAYMENT_ORDER_ASSIGNED:   'payment.order.assigned',
  PAYMENT_ORDER_PAID:       'payment.order.paid',
  PAYMENT_ORDER_COMPLETED:  'payment.order.completed',
  PAYMENT_ORDER_DISPUTED:   'payment.order.disputed',
  PAYMENT_ORDER_CANCELLED:  'payment.order.cancelled',
  PAYMENT_ORDER_EXPIRED:    'payment.order.expired',
  PAYMENT_ORDER_REJECTED:   'payment.order.rejected',

  // ── Wallet domain ─────────────────────────────────────────────────────────
  WALLET_CREDITED:          'wallet.credited',
  WALLET_DEBITED:           'wallet.debited',
  WALLET_RESERVE_ALLOCATED: 'wallet.reserve.allocated',

  // ── Betting domain ────────────────────────────────────────────────────────
  BET_PLACED:               'bet.placed',
  BET_SETTLED:              'bet.settled',
  BET_CANCELLED:            'bet.cancelled',

  // ── Casino domain (future — gated behind LIVE_CASINO feature flag) ────────
  CASINO_SESSION_STARTED:   'casino.session.started',
  CASINO_SESSION_ENDED:     'casino.session.ended',
  CASINO_GAME_RESULT:       'casino.game.result',
  CASINO_BALANCE_UPDATED:   'casino.balance.updated',

  // ── Sportsbook domain (future — gated behind SPORTSBOOK feature flag) ─────
  ODDS_UPDATED:             'sportsbook.odds.updated',
  MATCH_STARTED:            'sportsbook.match.started',
  MATCH_COMPLETED:          'sportsbook.match.completed',
  BET_SETTLED_SPORTS:       'sportsbook.bet.settled',

  // ── Notifications ─────────────────────────────────────────────────────────
  NOTIFICATION_CREATED:     'notification.created',

  // ── User / KYC ───────────────────────────────────────────────────────────
  USER_BLOCKED:             'user.blocked',
  KYC_APPROVED:             'kyc.approved',
  KYC_REJECTED:             'kyc.rejected',

  // ── System ───────────────────────────────────────────────────────────────
  MAINTENANCE_MODE_CHANGED: 'system.maintenance.changed',
  FEATURE_FLAG_CHANGED:     'system.feature_flag.changed',
});

/**
 * Publish a domain event.
 * @param {string} event    One of EVENTS.*
 * @param {object} payload  Event data
 */
export function publish(event, payload) {
  const envelope = { event, payload, ts: Date.now() };
  _bus.emit(event, envelope);
  // Also emit wildcard for logging / audit subscribers
  _bus.emit('*', envelope);
}

/**
 * Subscribe to a domain event.
 * @param {string}   event    One of EVENTS.* or '*' for all
 * @param {function} handler  Called with { event, payload, ts }
 * @returns {function}        Unsubscribe function
 */
export function subscribe(event, handler) {
  _bus.on(event, handler);
  return () => _bus.off(event, handler);
}

/**
 * Subscribe to an event once, returns a Promise.
 * @returns {Promise<{event, payload, ts}>}
 */
export function once(event) {
  return new Promise(resolve => _bus.once(event, resolve));
}

/** Remove all listeners (for test isolation). */
export function reset() { _bus.removeAllListeners(); }
'''

_FEATURE_FLAGS_SERVICE = GOV + '''\
/**
 * featureFlags.service.js — Runtime feature flag system.
 *
 * FLAGS are checked with: await isEnabled(FLAGS.LIVE_CASINO)
 *
 * PRIORITY ORDER (highest wins)
 *   1. Runtime override   — override(flag, true/false)
 *   2. Environment var    — FEATURE_LIVE_CASINO=true
 *   3. Default value      — defined in DEFAULTS below
 *
 * CDN CONFIG (call at startup after fetching from CDN edge)
 *   hydrateFromConfig({ LIVE_CASINO: true, SPORTSBOOK: false })
 *
 * REDIS BACKEND (future — swap _overrides Map for Redis hash)
 *   All call-sites using isEnabled() continue to work unchanged.
 *
 * TENANT SUPPORT (future)
 *   isEnabled(FLAGS.LIVE_CASINO, tenantId) — per-tenant flag resolution
 */

// ── Flag names (import FLAGS.* — never use raw strings) ───────────────────────
export const FLAGS = Object.freeze({
  // Casino & Sportsbook
  LIVE_CASINO:          'LIVE_CASINO',
  SPORTSBOOK:           'SPORTSBOOK',
  // Chat
  PUBLIC_CHAT:          'PUBLIC_CHAT',
  // Payments
  MULTI_CURRENCY:       'MULTI_CURRENCY',
  CRYPTO_PAYMENTS:      'CRYPTO_PAYMENTS',
  INTERNATIONAL_GATEWAY:'INTERNATIONAL_GATEWAY',
  // Notifications
  PUSH_NOTIFICATIONS:   'PUSH_NOTIFICATIONS',
  // Infrastructure
  KAFKA_EVENT_BUS:      'KAFKA_EVENT_BUS',
  REDIS_RATE_LIMITER:   'REDIS_RATE_LIMITER',
  READ_REPLICA:         'READ_REPLICA',
  // Multi-tenancy
  MULTI_TENANT:         'MULTI_TENANT',
  // Operations
  MAINTENANCE_MODE:     'MAINTENANCE_MODE',
});

// ── Default values ─────────────────────────────────────────────────────────────
const DEFAULTS = {
  [FLAGS.LIVE_CASINO]:           false,
  [FLAGS.SPORTSBOOK]:            false,
  [FLAGS.PUBLIC_CHAT]:           false,
  [FLAGS.MULTI_CURRENCY]:        false,
  [FLAGS.CRYPTO_PAYMENTS]:       false,
  [FLAGS.INTERNATIONAL_GATEWAY]: false,
  [FLAGS.PUSH_NOTIFICATIONS]:    false,
  [FLAGS.KAFKA_EVENT_BUS]:       false,
  [FLAGS.REDIS_RATE_LIMITER]:    true,
  [FLAGS.READ_REPLICA]:          false,
  [FLAGS.MULTI_TENANT]:          false,
  [FLAGS.MAINTENANCE_MODE]:      false,
};

const _overrides = new Map();

/**
 * Check if a feature flag is enabled.
 * @param {string}      flag    One of FLAGS.*
 * @param {string|null} tenant  Optional tenant ID
 * @returns {Promise<boolean>}
 */
export async function isEnabled(flag, tenant = null) {
  if (tenant) {
    const tk = `${tenant}:${flag}`;
    if (_overrides.has(tk)) return Boolean(_overrides.get(tk));
  }
  if (_overrides.has(flag)) return Boolean(_overrides.get(flag));
  const envKey = `FEATURE_${flag}`;
  if (process.env[envKey] !== undefined) {
    return process.env[envKey] === 'true' || process.env[envKey] === '1';
  }
  return Boolean(DEFAULTS[flag] ?? false);
}

/** Override a flag at runtime (for testing or live toggles). */
export function override(flag, value, tenant = null) {
  _overrides.set(tenant ? `${tenant}:${flag}` : flag, value);
}

/** Hydrate flags from a CDN-delivered JSON config object. */
export function hydrateFromConfig(config) {
  for (const [k, v] of Object.entries(config)) {
    if (k in DEFAULTS) _overrides.set(k, v);
  }
}

/** Snapshot of all current flag values (for admin / health endpoint). */
export async function getAllFlags(tenant = null) {
  const result = {};
  for (const flag of Object.values(FLAGS)) {
    result[flag] = await isEnabled(flag, tenant);
  }
  return result;
}
'''

_SSE_EVENT_TYPES = '''\
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file.
/**
 * sseEvents.types.ts — Typed catalog of all SSE events.
 *
 * Every SSE event the server can push to clients is defined here.
 * Import SSEEventType to get autocomplete and type-safety on event names.
 *
 * The realtime standard:
 *   SSE     — one-way server push (wallet updates, order status, notifications)
 *   Webhook — external providers push to server  (payment gateways, casino callbacks)
 *   WS      — only for bidirectional: game pool broadcasts, future public chat
 *   HTTP    — all commands (user actions)
 */

// ── Event names ────────────────────────────────────────────────────────────────
export const SSE_EVENTS = {
  // Wallet
  WALLET_UPDATE:            'wallet_update',
  RESERVE_BALANCE_UPDATE:   'reserve_balance_update',

  // Payment Orders
  ORDER_STATUS_CHANGED:     'order_status_changed',
  ORDER_ASSIGNED:           'order_assigned',
  ORDER_COMPLETED:          'order_completed',
  ORDER_EXPIRED:            'order_expired',

  // Merchant panel
  MERCHANT_NEW_ORDER:       'merchant_new_order',
  MERCHANT_ORDER_PAID:      'merchant_order_paid',

  // Admin queue
  ADMIN_QUEUE_UPDATE:       'admin_queue_update',
  ADMIN_NEW_ORDER:          'admin_new_order',

  // Game / Betting
  CYCLE_UPDATE:             'cycle_update',
  BET_RESULT:               'bet_result',

  // Casino (future — LIVE_CASINO flag)
  CASINO_SESSION_EVENT:     'casino_session_event',
  CASINO_BALANCE:           'casino_balance',

  // Sportsbook (future — SPORTSBOOK flag)
  ODDS_UPDATE:              'odds_update',
  MATCH_EVENT:              'match_event',

  // Notifications
  NOTIFICATION:             'notification',
  PUSH_NOTIFICATION:        'push_notification',

  // System
  MAINTENANCE:              'maintenance',
  FEATURE_FLAG:             'feature_flag',
} as const;

export type SSEEventName = typeof SSE_EVENTS[keyof typeof SSE_EVENTS];

// ── Payload types ──────────────────────────────────────────────────────────────

export interface WalletUpdatePayload {
  userId:          string;
  depositBalance:  number;
  winningsBalance: number;
  reserveBalance:  number;
  totalBalance:    number;
  ts:              number;
}

export interface OrderStatusPayload {
  orderId:    string;
  _id:        string;
  status:     string;
  type:       'DEPOSIT' | 'WITHDRAWAL';
  updatedAt:  string;
  ts:         number;
}

export interface CycleUpdatePayload {
  cycleId:     string;
  phase:       string;
  endTime:     number;
  pot:         number;
  ts:          number;
}

export interface NotificationPayload {
  id:      string;
  type:    string;
  title:   string;
  body:    string;
  data?:   Record<string, unknown>;
  ts:      number;
}

// Casino & Sportsbook payloads — defined but not used until flags are enabled.
export interface CasinoSessionPayload {
  providerId: string;
  userId:     string;
  event:      'started' | 'ended' | 'result';
  gameId?:    string;
  amount?:    number;
  ts:         number;
}

export interface OddsUpdatePayload {
  eventId:  string;
  market:   string;
  odds:     Array<{ name: string; odds: number }>;
  ts:       number;
}

// ── Generic SSE envelope ───────────────────────────────────────────────────────
export interface SSEEnvelope<T = unknown> {
  event:   SSEEventName;
  payload: T;
  ts:      number;
}
'''

def p2_01_create_payment_provider_interface(root: Path, dry_run: bool):
    log_info("P2-01 — Creating PaymentProvider.interface.js")
    write_file(root / "backend/providers/payment/PaymentProvider.interface.js", _PAYMENT_PROVIDER_INTERFACE, dry_run)

def p2_02_create_casino_provider_interface(root: Path, dry_run: bool):
    log_info("P2-02 — Creating CasinoProvider.interface.js")
    write_file(root / "backend/providers/casino/CasinoProvider.interface.js", _CASINO_PROVIDER_INTERFACE, dry_run)

def p2_03_create_sportsbook_provider_interface(root: Path, dry_run: bool):
    log_info("P2-03 — Creating SportsbookProvider.interface.js")
    write_file(root / "backend/providers/sportsbook/SportsbookProvider.interface.js", _SPORTSBOOK_PROVIDER_INTERFACE, dry_run)

def p2_04_create_provider_registry(root: Path, dry_run: bool):
    log_info("P2-04 — Creating provider registry.js")
    write_file(root / "backend/providers/registry.js", _PROVIDER_REGISTRY, dry_run)

def p2_05_create_event_bus(root: Path, dry_run: bool):
    log_info("P2-05 — Creating eventBus.service.js")
    write_file(root / "backend/services/eventBus.service.js", _EVENT_BUS_SERVICE, dry_run)

def p2_06_create_feature_flags(root: Path, dry_run: bool):
    log_info("P2-06 — Creating featureFlags.service.js")
    write_file(root / "backend/services/featureFlags.service.js", _FEATURE_FLAGS_SERVICE, dry_run)

def p2_07_create_sse_event_types(root: Path, dry_run: bool):
    log_info("P2-07 — Creating sseEvents.types.ts")
    write_file(root / "services/sseEvents.types.ts", _SSE_EVENT_TYPES, dry_run)


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 3 — Cleanup
# Remove .bak files, scan for dead/orphan files.
# ═════════════════════════════════════════════════════════════════════════════

def p3_01_cleanup_bak_files(root: Path, dry_run: bool):
    """Remove all .bak backup files created by the migration."""
    log_info("P3-01 — Removing .bak files")
    skip_dirs = {"node_modules", ".git"}
    baks = [
        p for p in root.rglob("*.bak")
        if not any(sd in p.parts for sd in skip_dirs)
    ]
    if not baks:
        log_ok("No .bak files found")
        return
    for bak in baks:
        if not dry_run:
            bak.unlink()
        log_delete(str(bak))
        record("deleted", bak)
    log_ok(f"Removed {len(baks)} .bak file(s)")

def p3_02_scan_dead_files(root: Path, dry_run: bool):
    """Scan for source files with zero import references (report only)."""
    log_info("P3-02 — Scanning for dead/orphaned source files")
    skip_dirs  = {"node_modules", ".git", "dist", "build", "tools"}
    extensions = {".js", ".ts", ".tsx", ".jsx"}
    # Build set of all imported file stems from import statements
    import_refs: set[str] = set()
    all_sources: list[Path] = []

    for fpath in root.rglob("*"):
        if fpath.is_dir() or fpath.name.endswith(".bak"):
            continue
        if any(sd in fpath.parts for sd in skip_dirs):
            continue
        if fpath.suffix not in extensions:
            continue
        all_sources.append(fpath)
        try:
            content = read_file(fpath)
            for m in re.finditer(r"""(?:from|import)\s+['"]([^'"]+)['"]""", content):
                ref = m.group(1).split("/")[-1]
                ref = re.sub(r'\.(js|ts|tsx|jsx)$', '', ref)
                import_refs.add(ref)
        except Exception:
            pass

    # Entry points / configs that are valid even without imports
    always_alive = {
        "server", "index", "main", "vite.config", "tailwind.config",
        "postcss.config", "eslint.config", "vitest.config", "playwright.config",
        "ecosystem.config", "domain_migration", "validate-migration",
        "run-migration", "rollback",
    }

    dead: list[Path] = []
    for src in all_sources:
        stem = re.sub(r'\.(js|ts|tsx|jsx)$', '', src.name)
        if stem in import_refs or stem in always_alive:
            continue
        # Also skip index files (they're entry barrel exports)
        if src.name in ("index.js", "index.ts", "index.tsx"):
            continue
        dead.append(src)

    if dead:
        log_warn(f"Potentially dead files ({len(dead)}) — review before deleting:")
        for d in dead[:20]:
            log_warn(f"  {d.relative_to(root)}")
        if len(dead) > 20:
            log_warn(f"  ... and {len(dead)-20} more")
    else:
        log_ok("No obvious dead files found")


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 4 — Report
# Write a machine-readable migration report.
# ═════════════════════════════════════════════════════════════════════════════

def p4_01_generate_report(root: Path, dry_run: bool):
    """Write tools/migration-report.json with full summary."""
    log_info("P4-01 — Generating migration report")
    if dry_run:
        return
    report = {
        "generated_at": datetime.now().isoformat(),
        "repo_root":    str(root),
        "summary": {
            "created":  len(SUMMARY["created"]),
            "modified": len(SUMMARY["modified"]),
            "deleted":  len(SUMMARY["deleted"]),
            "skipped":  len(SUMMARY["skipped"]),
        },
        "files": SUMMARY,
        "state": _STATE.completed_steps() if _STATE else [],
    }
    report_path = root / "tools" / "migration-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2))
    log_ok(f"Report written to {report_path}")


# ═════════════════════════════════════════════════════════════════════════════
# PHASE REGISTRY
# ═════════════════════════════════════════════════════════════════════════════

PHASE_0 = [
    step_delete_p2p_files,
    step_create_payment_order_model,
    step_create_payment_service,
    step_create_payment_routes,
    step_patch_models_index,
    step_patch_server_js,
    step_patch_cron_jobs,
    step_patch_admin_routes,
    step_patch_merchant_routes,
    step_patch_frontend_types,
    step_create_payment_state_machine,
    step_patch_wallet_modal,
    step_patch_frontend_files,
    step_patch_backend_interface,
    step_patch_real_backend,
    step_patch_wallet_dto,
    step_patch_merchant_panel,
    step_patch_admin_queue_dashboard,
    step_patch_upload_routes,
    step_patch_sse_routes,
    step_patch_socket_handlers,
    step_patch_dispute_routes,
    step_patch_wallet_services,
    step_patch_auth_middleware,
    step_ensure_governance_headers,
    step_safety_sweep,
]

PHASE_1 = [
    p1_01_delete_legacy_p2p_model,
    p1_02_patch_validation_schema,
    p1_03_patch_wallet_page,
    p1_04_strip_p2p_state_machine_aliases,
    p1_05_strip_p2p_order_alias,
    p1_06_remove_legacy_redirect_shim,
]

PHASE_2 = [
    p2_01_create_payment_provider_interface,
    p2_02_create_casino_provider_interface,
    p2_03_create_sportsbook_provider_interface,
    p2_04_create_provider_registry,
    p2_05_create_event_bus,
    p2_06_create_feature_flags,
    p2_07_create_sse_event_types,
]

PHASE_3 = [
    p3_01_cleanup_bak_files,
    p3_02_scan_dead_files,
]

PHASE_4 = [
    p4_01_generate_report,
]

PHASES: dict[str, list] = {
    "core":         PHASE_0,
    "patches":      PHASE_1,
    "architecture": PHASE_2,
    "cleanup":      PHASE_3,
    "report":       PHASE_4,
    "all":          PHASE_0 + PHASE_1 + PHASE_2 + PHASE_3 + PHASE_4,
}


# ═════════════════════════════════════════════════════════════════════════════
# Embedded content constants (paymentOrder model, service, routes, types)
# These are large strings kept at the bottom to keep the step logic readable.
# ═════════════════════════════════════════════════════════════════════════════

_PAYMENT_ORDER_MODEL = GOV + r'''/** paymentOrder.model.js — Merchant Payment Processing domain v1.0.0 */
import mongoose from 'mongoose';
import { setOrderHmacHook } from '../middleware/order-crypto-access.js';
const paymentOrderSchema = new mongoose.Schema({
  orderId:        { type: String, required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
  merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', index: true },
  type:           { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },
  tokenAmount:    { type: Number, required: true },
  fiatAmount:     { type: Number, required: true },
  amount:         { type: Number },
  rateUsed:       { type: Number, required: true },
  merchantProfit: { type: Number, default: 0 },
  merchantFee:    { type: Number, default: 0 },
  depositAllocation: { type: Number, default: 0 },
  reserveAllocation: { type: Number, default: 0 },
  platformFeeRate:   { type: Number, default: 0.03 },
  status: {
    type: String,
    enum: ['PENDING_QUEUE','ASSIGNED','PROCESSING','PAID','COMPLETED','DISPUTED','CANCELLED','FAILED','REJECTED'],
    default: 'PENDING_QUEUE', index: true,
  },
  escrowStatus:    { type: String, enum: ['NONE','LOCKED','RELEASED','REFUNDED'], default: 'NONE' },
  userPhone:       String,
  userKycSnapshot: { pan: String, name: String },
  userBankDetails: { accountNumber: String, ifscCode: String, bankName: String, accountHolderName: String },
  requiresVideoKYC: { type: Boolean, default: false },
  utrNumber:       String,
  proofScreenshot: String,
  utrWarning:      String,
  utrWarningMessage: String,
  utrWarningData:  { type: mongoose.Schema.Types.Mixed },
  requiresReview:  { type: Boolean, default: false },
  reviewedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:      Date,
  reviewAction:    String,
  reviewNotes:     String,
  rejectedReason:  String,
  disputeEscalation: [{ escalatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, escalationNotes: String, escalatedAt: Date }],
  disputeStatus:   String,
  disputeResolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  disputeResolvedAt: Date,
  disputeDecision: String,
  disputeResolution: String,
  refundedAmount:  { type: Number, default: 0 },
  disputeReason:   String,
  mediatorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolutionNotes: String,
  assignedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedAt:      Date,
  merchantPanelUrl: { type: String, default: null },
  redFlagged:      { type: Boolean, default: false },
  redFlagReason:   String,
  redFlaggedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  redFlaggedAt:    Date,
  bulkPayoutDate:  Date,
  bulkPaidAt:      Date,
  bulkPayoutBatch: String,
  expiresAt:       Date,
  merchantSnapshot: {
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
    merchantName: String, upiId: String, bankName: String,
    accountNo: String, ifsc: String, accountHolder: String,
    snapshotAt: Date, expiresAt: Date,
  },
  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
  approvedAt:  Date,
  rejectedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
  rejectedAt:  Date,
  cancelReason: String,
  cancelledAt:  Date,
  warningIssued: { type: Boolean, default: false },
  createdAt:  { type: Date, default: Date.now, index: true },
  updatedAt:  { type: Date, default: Date.now },
  paidAt:     Date,
  completedAt: Date,
});
paymentOrderSchema.add({ orderHmac: { type: String, select: false } });
paymentOrderSchema.pre('save', setOrderHmacHook);
paymentOrderSchema.pre('save', function(next) {
  if (this.fiatAmount !== undefined) this.amount = this.fiatAmount;
  if (this.isNew && this.type === 'DEPOSIT') {
    this.depositAllocation = Math.floor(this.tokenAmount * 0.90);
    this.reserveAllocation  = this.tokenAmount - this.depositAllocation;
  }
  next();
});
paymentOrderSchema.index({ status: 1, type: 1, createdAt: 1 });
paymentOrderSchema.index({ merchantId: 1, status: 1 });
paymentOrderSchema.index({ expiresAt: 1, status: 1 });
paymentOrderSchema.index({ bulkPayoutDate: 1, type: 1, status: 1 });
export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
'''

_PAYMENT_SERVICE = GOV + '''\
/** paymentProcessing.service.js — Merchant Payment Processing v1.0.0 */
import mongoose from 'mongoose';
import crypto   from 'crypto';
import { debitWinningsForWithdrawal, creditDeposit, creditWinnings } from './walletAuthority.service.js';
import { markUTRAsUsed, releaseUTR }   from '../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from './realtimeEmitters.js';

async function safeSession() {
  try { const s = await mongoose.startSession(); s.startTransaction(); return s; }
  catch { console.warn('[paymentProcessing] standalone MongoDB — no session'); return null; }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction(); }  finally { s.endSession(); } }
function withSession(s) { return s ? { session: s } : {}; }
function isAfter7pmIST() { return new Date(Date.now() + 5.5 * 3600000).getUTCHours() >= 19; }

export async function createDepositOrder(userId, tokenAmount) {
  const session = await safeSession();
  try {
    const User = mongoose.model('User');
    const PaymentOrder = mongoose.model('PaymentOrder');
    const rates = await mongoose.model('TokenRates').findOne({ key: 'main' }, null, withSession(session));
    if (!rates?.buyRate) throw Object.assign(new Error('Token rates not configured.'), { status: 503 });
    const user = await User.findById(userId, null, withSession(session));
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    if (user.isBlocked) throw Object.assign(new Error('Account suspended.'), { status: 403, code: 'USER_BLOCKED' });
    if (user.kycStatus !== 'APPROVED') throw Object.assign(new Error('Complete KYC to purchase tokens'), { status: 403 });
    const fiatAmount = tokenAmount * rates.buyRate;
    const order = new PaymentOrder({
      orderId: `DEP_${crypto.randomBytes(12).toString('hex')}`,
      type: 'DEPOSIT', userId: user._id,
      tokenAmount, fiatAmount, rateUsed: rates.buyRate,
      merchantProfit: tokenAmount * (rates.buyRate - rates.sellRate),
      status: 'PENDING_QUEUE', createdAt: new Date(),
    });
    await order.save(withSession(session));
    await commitOrEnd(session);
    emitAdminUpdate('new_order', { orderId: order.orderId, type: 'DEPOSIT', tokenAmount, fiatAmount, userId: user._id, server_ts: Date.now() });
    return { order: { _id: order._id, orderId: order.orderId, tokenAmount, fiatAmount, depositAllocation: order.depositAllocation, reserveAllocation: order.reserveAllocation, rateUsed: rates.buyRate, status: order.status } };
  } catch (err) { await abortOrEnd(session); throw err; }
}

export async function createWithdrawalOrder(userId, tokenAmount) {
  if (isAfter7pmIST()) throw Object.assign(new Error('Sell orders close at 7 PM IST.'), { status: 400, cutoffPassed: true });
  const session = await safeSession();
  try {
    const user = await mongoose.model('User').findById(userId, null, withSession(session));
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    if (user.winningsBalance < tokenAmount) throw Object.assign(new Error(`Insufficient winnings balance. Available: ₹${user.winningsBalance}`), { status: 400 });
    const rates = await mongoose.model('TokenRates').findOne({ key: 'main' }, null, withSession(session));
    if (!rates?.sellRate) throw Object.assign(new Error('Token rates not configured.'), { status: 503 });
    const fiatAmount = tokenAmount * rates.sellRate;
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const bulkPayoutDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
    const order = new (mongoose.model('PaymentOrder'))({
      orderId: `WD_${crypto.randomBytes(12).toString('hex')}`,
      type: 'WITHDRAWAL', userId: user._id,
      tokenAmount, fiatAmount, rateUsed: rates.sellRate,
      status: 'PENDING_QUEUE', createdAt: new Date(), bulkPayoutDate,
      userBankDetails: { accountNumber: user.bankDetails?.accountNumber || '', ifscCode: user.bankDetails?.ifscCode || '', bankName: user.bankDetails?.bankName || '', accountHolderName: user.bankDetails?.accountHolderName || user.username || '' },
      userPhone: user.mobile,
    });
    const debitResult = await debitWinningsForWithdrawal(String(user._id), tokenAmount, order._id.toString(), session);
    await order.save(withSession(session));
    await commitOrEnd(session);
    emitAdminUpdate('new_order', { orderId: order.orderId, type: 'WITHDRAWAL', tokenAmount, fiatAmount, userId: user._id, server_ts: Date.now() });
    await emitWalletUpdate(user._id);
    return { order: { _id: order._id, orderId: order.orderId, tokenAmount, fiatAmount, rateUsed: rates.sellRate, status: order.status }, remainingBalance: { winnings: debitResult.winningsAfter ?? (user.winningsBalance - tokenAmount) } };
  } catch (err) { await abortOrEnd(session); throw err; }
}

export async function markOrderPaid(userId, orderId, utrNumber, proofScreenshot) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (order.userId.toString() !== userId.toString()) throw Object.assign(new Error('Access denied'), { status: 403 });
  if (!['ASSIGNED','PROCESSING'].includes(order.status)) throw Object.assign(new Error(`Cannot mark paid in ${order.status} status`), { status: 400 });
  const normalizedUTR = utrNumber.toUpperCase().replace(/\\s+/g, '');
  await markUTRAsUsed(normalizedUTR, order._id, order.userId, order.fiatAmount);
  order.status = 'PAID'; order.utrNumber = normalizedUTR; order.proofScreenshot = proofScreenshot.trim(); order.paidAt = new Date(); order.updatedAt = new Date();
  await order.save();
  if (order.merchantId) emitMerchantUpdate(order.merchantId.toString(), 'order_paid', { orderId: order.orderId, status: 'PAID', utrNumber: normalizedUTR, fiatAmount: order.fiatAmount, paidAt: order.paidAt, server_ts: Date.now() });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PAID', server_ts: Date.now() });
  return order;
}

export async function cancelOrder(actorId, isAdmin, orderId) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (order.userId.toString() !== actorId.toString() && !isAdmin) throw Object.assign(new Error('Access denied'), { status: 403 });
  if (order.status !== 'PENDING_QUEUE') throw Object.assign(new Error('Cannot cancel at this stage'), { status: 400 });
  if (order.type === 'WITHDRAWAL') await creditWinnings(order.userId, order.tokenAmount, `Withdrawal refund ${order.orderId}`, 'PaymentOrder', order._id, `wd_refund_${order._id}`);
  order.status = 'CANCELLED'; order.cancelReason = 'USER_CANCELLED'; order.cancelledAt = new Date(); order.updatedAt = new Date();
  await order.save();
  await emitWalletUpdate(order.userId);
  return order;
}

export async function expireOrders() {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const now = new Date();
  const expired = await PaymentOrder.find({ status: { $in: ['ASSIGNED','PROCESSING'] }, expiresAt: { $lt: now } });
  let count = 0;
  for (const order of expired) {
    try {
      order.status = 'CANCELLED'; order.cancelReason = 'EXPIRED'; order.cancelledAt = now; order.updatedAt = now;
      await order.save();
      emitOrderUpdate(order.userId.toString(), 'order_expired', { orderId: order.orderId, status: 'CANCELLED', reason: 'EXPIRED', server_ts: Date.now() });
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'CANCELLED', reason: 'EXPIRED' });
      count++;
    } catch (e) { console.error('[expireOrders]', order.orderId, e.message); }
  }
  return count;
}
'''

_PAYMENT_ROUTES = GOV + '''\
/** payment.routes.js — Merchant Payment Processing routes v1.0.0 */
import express   from 'express';
import mongoose  from 'mongoose';
import { authenticate } from '../middleware/auth.middleware.js';
import { withdrawalLimiter } from '../middleware/security.js';
import { createDepositOrder, createWithdrawalOrder, markOrderPaid, cancelOrder } from '../services/paymentProcessing.service.js';
import { creditDeposit } from '../services/walletAuthority.service.js';
import { releaseUTR } from '../middleware/utrValidation.js';
import { emitWalletUpdate, emitAdminUpdate } from '../services/realtimeEmitters.js';

const router = express.Router();

async function safeSession() {
  try { const s = await mongoose.startSession(); s.startTransaction(); return s; } catch { return null; }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction(); }  finally { s.endSession(); } }
function withSession(s) { return s ? { session: s } : {}; }

router.post('/deposit/create', authenticate, async (req, res) => {
  try {
    const result = await createDepositOrder(req.user._id, Number(req.body.tokenAmount));
    res.json({ success: true, message: 'Deposit request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }); }
});

router.post('/withdrawal/create', authenticate, withdrawalLimiter, async (req, res) => {
  try {
    const result = await createWithdrawalOrder(req.user._id, Number(req.body.tokenAmount));
    res.json({ success: true, message: 'Withdrawal request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, cutoffPassed: err.cutoffPassed, balance: err.balance }); }
});

router.post('/order/:orderId/mark-paid', authenticate, async (req, res) => {
  try {
    const { utrNumber, proofScreenshot } = req.body;
    if (!utrNumber?.trim()) return res.status(400).json({ success: false, message: 'utrNumber is required' });
    if (!proofScreenshot?.trim()) return res.status(400).json({ success: false, message: 'proofScreenshot (CDN URL) is required' });
    const order = await markOrderPaid(req.user._id, req.params.orderId, utrNumber, proofScreenshot);
    res.json({ success: true, message: 'Payment marked. Awaiting merchant review.', order });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, originalOrderId: err.originalOrderId }); }
});

router.post('/deposit/:orderId/confirm', authenticate, async (req, res) => {
  if (!req.user.isMerchant && !req.user.isAdmin) return res.status(403).json({ success: false, message: 'Only merchants can confirm deposits' });
  const session = await safeSession();
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ orderId: req.params.orderId }, null, withSession(session));
    if (!order || order.type !== 'DEPOSIT') { await abortOrEnd(session); return res.status(404).json({ success: false, message: 'Order not found' }); }
    if (!['PAID','PROCESSING'].includes(order.status)) { await abortOrEnd(session); return res.status(400).json({ success: false, message: `Cannot confirm in ${order.status} status` }); }
    const depositTokens = order.depositAllocation || order.tokenAmount;
    const updatedMerchant = await mongoose.model('Merchant').findOneAndUpdate({ _id: order.merchantId, tokenBalance: { $gte: depositTokens } }, { $inc: { tokenBalance: -depositTokens } }, { ...withSession(session), new: true });
    if (!updatedMerchant) { await abortOrEnd(session); return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' }); }
    await creditDeposit(order.userId, depositTokens, order._id.toString(), session);
    if ((order.reserveAllocation || 0) > 0) await mongoose.model('User').findByIdAndUpdate(order.userId, { $inc: { reserveBalance: order.reserveAllocation } }, withSession(session));
    order.status = 'COMPLETED'; order.completedAt = new Date(); order.approvedBy = req.merchantId || req.user._id; order.approvedAt = new Date(); order.updatedAt = new Date();
    await order.save(withSession(session));
    await releaseUTR(order._id);
    await mongoose.model('Transaction').create([{ userId: order.userId, type: 'DEPOSIT', amount: order.tokenAmount, balanceType: 'DEPOSIT', status: 'SUCCESS', referenceId: order._id.toString(), description: `Deposit completed: ${order.tokenAmount} tokens`, timestamp: new Date() }], withSession(session));
    await commitOrEnd(session);
    await emitWalletUpdate(order.userId);
    res.json({ success: true, message: 'Deposit completed', order });
  } catch (err) { await abortOrEnd(session); res.status(500).json({ success: false, message: 'Failed to confirm deposit' }); }
});

router.get('/orders', authenticate, async (req, res) => {
  try {
    const { status, type, limit = 20, skip = 0 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip) || 0, 0);
    const PaymentOrder = mongoose.model('PaymentOrder');
    const query = { userId: req.user._id };
    if (status) query.status = status;
    if (type)   query.type   = type;
    const [orders, total] = await Promise.all([
      PaymentOrder.find(query).sort({ createdAt: -1 }).limit(parsedLimit).skip(parsedSkip),
      PaymentOrder.countDocuments(query),
    ]);
    res.json({ success: true, orders, pagination: { total, limit: parsedLimit, skip: parsedSkip } });
  } catch { res.status(500).json({ success: false, message: 'Failed to fetch orders' }); }
});

router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId.match(/^[0-9a-fA-F]{24}$/) ? req.params.orderId : null }] }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString() && !req.user.isAdmin) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/rates', async (req, res) => {
  try {
    const rates = await mongoose.model('TokenRates').findOne({ key: 'main' });
    if (!rates) return res.json({ success: true, rates: null });
    res.json({ success: true, rates: { buyRate: rates.buyRate, sellRate: rates.sellRate, merchantProfitPerToken: rates.buyRate - rates.sellRate } });
  } catch { res.status(500).json({ success: false, message: 'Failed to fetch rates' }); }
});

router.post('/order/cancel', authenticate, async (req, res) => {
  try {
    await cancelOrder(req.user._id, req.user.isAdmin, req.body.orderId);
    res.json({ success: true, message: 'Order cancelled' });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

router.post('/order/:orderId/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const VALID = { PAID: ['DISPUTED'] };
    if (!(VALID[order.status] || []).includes(status)) return res.status(400).json({ success: false, message: `Cannot transition ${order.status} → ${status}` });
    order.status = status; order.updatedAt = new Date();
    await order.save();
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: order.status });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to update status' }); }
});

export default router;
'''

_PAYMENT_ORDER_TYPES = '''
export type PaymentOrderStatus =
  | 'PENDING_QUEUE' | 'ASSIGNED' | 'PROCESSING' | 'PAID'
  | 'COMPLETED' | 'DISPUTED' | 'CANCELLED' | 'FAILED' | 'REJECTED';

export interface MerchantSnapshot {
  merchantId: string; merchantName: string; upiId: string;
  bankName: string; accountNo: string; ifsc: string;
  accountHolder: string; snapshotAt: string; expiresAt: string;
}

export interface PaymentOrder {
  id: string; _id: string; orderId: string;
  userId: string; merchantId: string | null;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  tokenAmount: number; fiatAmount: number; rateUsed: number;
  merchantProfit: number;
  depositAllocation: number;
  reserveAllocation: number;
  platformFeeRate: number;
  status: PaymentOrderStatus;
  escrowStatus: 'NONE' | 'LOCKED' | 'RELEASED' | 'REFUNDED';
  utrNumber?: string; proofScreenshot?: string;
  requiresVideoKYC: boolean;
  merchantSnapshot?: MerchantSnapshot;
  utrWarning?: string; requiresReview: boolean;
  warningIssued: boolean; redFlagged: boolean;
  bulkPayoutDate?: string; bulkPayoutBatch?: string;
  expiresAt?: string; createdAt: number | string;
  paidAt?: string; completedAt?: string;
}

export interface TokenRates {
  buyRate: number; sellRate: number; updatedAt: number;
}
'''

_PAYMENT_STATE_MACHINE = '''\
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file.
/** paymentStateMachine.ts — Merchant Payment Processing state machine v1.0.0 */

export const PAYMENT_STATES = [
  'PENDING_QUEUE','ASSIGNED','PROCESSING','PAID',
  'COMPLETED','DISPUTED','REJECTED','FAILED','CANCELLED',
] as const;

export type PaymentOrderState = typeof PAYMENT_STATES[number];

export const ACTIVE_STATES: PaymentOrderState[] = ['PENDING_QUEUE','ASSIGNED','PROCESSING','PAID','DISPUTED'];
export const TERMINAL_STATES: PaymentOrderState[] = ['COMPLETED','REJECTED','FAILED','CANCELLED'];

export const PAYMENT_STATE_LABELS: Record<PaymentOrderState, string> = {
  PENDING_QUEUE: 'Waiting for Merchant',
  ASSIGNED:      'Merchant Assigned — Submit Payment',
  PROCESSING:    'Payment Processing',
  PAID:          'Payment Submitted — Awaiting Merchant Review',
  COMPLETED:     'Completed',
  DISPUTED:      'Under Dispute',
  REJECTED:      'Order Rejected',
  FAILED:        'Order Failed',
  CANCELLED:     'Cancelled',
};

export const PAYMENT_STATE_COLOR: Record<PaymentOrderState, 'yellow'|'blue'|'green'|'red'|'orange'> = {
  PENDING_QUEUE: 'yellow', ASSIGNED: 'blue', PROCESSING: 'orange', PAID: 'orange',
  COMPLETED: 'green', DISPUTED: 'red', REJECTED: 'red', FAILED: 'red', CANCELLED: 'red',
};

export const isActive   = (s: PaymentOrderState) => ACTIVE_STATES.includes(s);
export const isTerminal = (s: PaymentOrderState) => TERMINAL_STATES.includes(s);
export const evidencePanelVisible     = (s: PaymentOrderState) => ['ASSIGNED','PROCESSING'].includes(s);
export const paymentDetailsPanelVisible = (s: PaymentOrderState) => ['ASSIGNED','PROCESSING','PAID'].includes(s);
'''


# ═════════════════════════════════════════════════════════════════════════════
# SUMMARY + MAIN
# ═════════════════════════════════════════════════════════════════════════════

def print_summary():
    print()
    print(f"{BOLD}{'═' * 62}{RESET}")
    print(f"{BOLD}MIGRATION SUMMARY{RESET}")
    print(f"{'═' * 62}")
    print(f"  {GREEN}Created:{RESET}   {len(SUMMARY['created'])} file(s)")
    for p in SUMMARY["created"]:    print(f"    + {p}")
    print(f"  {YELLOW}Modified:{RESET}  {len(SUMMARY['modified'])} file(s)")
    for p in SUMMARY["modified"]:   print(f"    ~ {p}")
    print(f"  {RED}Deleted:{RESET}   {len(SUMMARY['deleted'])} file(s)")
    for p in SUMMARY["deleted"]:    print(f"    - {p}")
    print(f"  {CYAN}Skipped:{RESET}   {len(SUMMARY['skipped'])} step(s) (already complete)")
    print(f"{'═' * 62}")
    total = len(SUMMARY["created"]) + len(SUMMARY["modified"]) + len(SUMMARY["deleted"])
    print(f"  Total changes: {total} file(s)")
    if _STATE:
        print(f"  State: {_STATE.summary()}")
    print(f"{'═' * 62}")


def detect_repo_root(start: Path) -> Path:
    candidate = start.resolve()
    for _ in range(6):
        if (candidate / "backend").is_dir() and (candidate / "package.json").is_file():
            return candidate
        candidate = candidate.parent
    raise RuntimeError(f"Cannot locate repo root from {start}. Use --repo-root.")


def main():
    global _STATE

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo-root",    default=None,   help="Path to repository root")
    parser.add_argument("--dry-run",      action="store_true", help="Show changes without writing")
    parser.add_argument("--phase",        default="all",
                        choices=list(PHASES.keys()),
                        help="Which phase(s) to run (default: all)")
    parser.add_argument("--force",        action="store_true",
                        help="Re-run steps already marked complete in state file")
    parser.add_argument("--reset-state",  action="store_true",
                        help="Clear migration state and start fresh")
    args = parser.parse_args()

    root = Path(args.repo_root).resolve() if args.repo_root else detect_repo_root(Path.cwd())
    if not root.is_dir():
        log_error(f"Repository root not found: {root}")
        sys.exit(1)

    state_path = root / "tools" / ".migration-state.json"
    _STATE = MigrationState(state_path)

    if args.reset_state:
        _STATE.reset()
        log_ok("Migration state reset")

    print(f"{BOLD}Betting Bazaar — Domain Migration Engine{RESET}")
    print(f"  Repository : {root}")
    print(f"  Phase      : {args.phase}")
    print(f"  Dry run    : {args.dry_run}")
    print(f"  Force      : {args.force}")
    print(f"  State      : {_STATE.summary()}")
    print()

    steps = PHASES[args.phase]
    step_count = len(steps)
    failed_count = 0

    for i, fn in enumerate(steps, 1):
        print(f"{CYAN}[{i:02d}/{step_count:02d}]{RESET}", end=" ", flush=True)
        try:
            run_step(fn, root, args.dry_run, force=args.force)
        except Exception as exc:
            log_error(f"{fn.__name__} FAILED: {exc}")
            failed_count += 1
            # Continue to next step — don't abort the whole run

    print_summary()

    if failed_count > 0:
        log_error(f"{failed_count} step(s) failed. Fix above errors and re-run.")
        print("Run validate-migration.sh to diagnose remaining issues.")
        sys.exit(1)
    else:
        print(f"\n{GREEN}{BOLD}Migration complete.{RESET}")
        print("Next: bash tools/validate-migration.sh --repo-root .")
        print()


if __name__ == "__main__":
    main()