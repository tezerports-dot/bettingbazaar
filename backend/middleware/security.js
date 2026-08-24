// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { AuditLog } from '../models/index.js';
// F-3 (2026-07-10): counters shared across instances via Redis; graceful
// per-instance fallback when Redis is absent/unreachable.
import { createRateLimitStore } from './redisRateLimitStore.js';
// Item 19 (2026-07-13): windows/limits live in config/security.config.js —
// values unchanged; edit the config to change policy.
import { RATE_LIMIT_TIERS } from '../config/security.config.js';
import { betBehaviorLimiter } from './behavioralRateLimit.js';

// ==================== AUTHENTICATION RATE LIMITERS ====================

// Stricter rate limiting for authentication endpoints
// Prevents brute force password attacks
export const authLimiter = rateLimit({
    store: createRateLimitStore('rl:auth:'),
    ...RATE_LIMIT_TIERS.auth, // 4 FAILED / 30 min
    message: { 
        success: false,
        message: "Too many failed login attempts. Please try again in 30 minutes.",
        retryAfter: 1800 // seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Track by IP address (ipKeyGenerator normalizes IPv6 to a /56 so a single
    // v6 user can't rotate addresses within their block to bypass the limit — AQ-6).
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    // Skip successful requests
    skipSuccessfulRequests: true,
    // Custom handler for rate limit exceeded
    handler: (req, res) => {
        console.warn('⚠️ SECURITY: Rate limit exceeded', {
            ip: req.ip,
            path: req.path,
            timestamp: new Date().toISOString()
        });
        
        // Log to audit trail
        AuditLog.create({
            adminId: 'SYSTEM_SECURITY',
            action: 'RATE_LIMIT_EXCEEDED',
            details: `Too many auth attempts from ${req.ip} to ${req.path}`,
            ip: req.ip,
            timestamp: new Date()
        }).catch(console.error);
        
        res.status(429).json({
            success: false,
            message: "Too many failed login attempts. Please try again in 30 minutes.",
            retryAfter: 1800
        });
    }
});

// Separate, even stricter limiter for admin logins
// Admins need extra protection
export const adminAuthLimiter = rateLimit({
    store: createRateLimitStore('rl:adminauth:'),
    ...RATE_LIMIT_TIERS.adminAuth, // 4 FAILED / hour
    message: { 
        success: false,
        message: "Too many failed admin login attempts. Please try again in an hour.",
        retryAfter: 3600
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
        console.error('🚨 SECURITY ALERT: Admin auth rate limit exceeded', {
            ip: req.ip,
            mobile: req.body?.mobile,
            timestamp: new Date().toISOString()
        });
        
        AuditLog.create({
            adminId: 'SYSTEM_SECURITY',
            action: 'ADMIN_RATE_LIMIT_EXCEEDED',
            details: `Multiple failed admin login attempts from ${req.ip}`,
            ip: req.ip,
            timestamp: new Date()
        }).catch(console.error);
        
        res.status(429).json({
            success: false,
            message: "Too many failed admin login attempts. Account security triggered. Please try again in an hour or contact support.",
            retryAfter: 3600
        });
    }
});

// ==================== BETTING RATE LIMITERS ====================

// Rate limiter for bet placement
// Prevents rapid-fire betting and potential abuse
// Merchant login. Deliberately its own limiter rather than sharing the player
// tier: a merchant account settles real INR and USDT, so a brute-force against
// it is an attack on the settlement rail, not on one player's balance.
export const merchantAuthLimiter = rateLimit({
    store: createRateLimitStore('rl:merchantauth:'),
    ...RATE_LIMIT_TIERS.merchantAuth, // 4 FAILED / hour
    message: {
        success: false,
        message: "Too many failed merchant login attempts. Please try again in an hour.",
        retryAfter: 3600
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: (req, res) => {
        console.error('🚨 SECURITY ALERT: Merchant auth rate limit exceeded', {
            ip: req.ip, path: req.path, timestamp: new Date().toISOString(),
        });
        AuditLog.create({
            adminId: 'SYSTEM_SECURITY',
            action: 'MERCHANT_RATE_LIMIT_EXCEEDED',
            details: `Multiple failed merchant login attempts from ${req.ip}`,
            ip: req.ip, timestamp: new Date(),
        }).catch(console.error);
        res.status(429).json({
            success: false,
            message: "Too many failed merchant login attempts. Please try again in an hour.",
            retryAfter: 3600,
        });
    },
});

// Second-factor submission, once the password has already been accepted.
// Counted separately from the password tier because the search space is very
// different: six digits is 10^6, so the same allowance that is generous for a
// password is dangerous for an OTP. Keyed by account where known, so one
// attacker cannot exhaust a shared-IP office's whole budget.
export const twoFactorLimiter = rateLimit({
    store: createRateLimitStore('rl:2fa:'),
    ...RATE_LIMIT_TIERS.twoFactor, // 5 FAILED / 15 min
    message: {
        success: false,
        message: "Too many incorrect authentication codes. Please wait before trying again.",
        retryAfter: 900
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => req.user?.id || req.body?.mobile || ipKeyGenerator(req.ip),
    // Audited at the loudest level of any limiter here. Tripping THIS one means
    // the password was already accepted and only the second factor is being
    // guessed — i.e. a credential is already compromised and a takeover is in
    // progress. That is a different and more urgent signal than a failed
    // password, and it should never be inferred from a 429 count alone.
    handler: (req, res) => {
        console.error('🚨 SECURITY ALERT: 2FA code rate limit exceeded — possible account takeover in progress', {
            ip: req.ip, userId: req.user?.id, path: req.path, timestamp: new Date().toISOString(),
        });
        AuditLog.create({
            adminId: 'SYSTEM_SECURITY',
            action: 'TWO_FACTOR_RATE_LIMIT_EXCEEDED',
            details: `Repeated invalid 2FA codes from ${req.ip} for account ${req.user?.id || req.body?.mobile || 'unknown'} — password already accepted`,
            ip: req.ip, timestamp: new Date(),
        }).catch(console.error);
        res.status(429).json({
            success: false,
            message: "Too many incorrect authentication codes. Please wait before trying again.",
            retryAfter: 900,
        });
    },
});

export const ipBetLimiter = rateLimit({
    store: createRateLimitStore('rl:bet:'),
    ...RATE_LIMIT_TIERS.bet, // 30 / min
    message: { 
        success: false,
        message: "Slow down! You are placing bets too quickly. Please wait a moment."
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Track per user, not per IP (users may share IPs)
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip)
});

// This inexpensive IP-only guard deliberately runs before authentication on bet placement.
export const unauthenticatedBetIpLimiter = rateLimit({
    store: createRateLimitStore('rl:bet-unauth-ip:'),
    ...RATE_LIMIT_TIERS.bet,
    message: { success: false, message: 'Too many bet requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip)
});

export const betLimiter = [ipBetLimiter, betBehaviorLimiter];

// ==================== ACCOUNT RECOVERY RATE LIMITER ====================

/**
 * Guards the Aadhaar-keyed recovery endpoints.
 *
 * Keyed on the IP (normalised for IPv6 like the auth tiers), NOT on any field
 * from the request. The previous guard was an in-process Map keyed on the
 * `mobile` value the CALLER supplies, which failed three ways at once: the
 * caller chose their own bucket, the counters were invisible to the other PM2
 * workers, and a restart cleared them. Backed by the shared Redis store so the
 * limit is one budget across every process on the box.
 */
export const accountRecoveryLimiter = rateLimit({
    store: createRateLimitStore('rl:recovery:'),
    ...RATE_LIMIT_TIERS.accountRecovery,
    message: {
        success: false,
        message: 'Too many recovery attempts. Please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
});

// ==================== WITHDRAWAL RATE LIMITERS ====================

// Rate limiter for withdrawal requests
// Prevents rapid withdrawal attempts
export const withdrawalLimiter = rateLimit({
    store: createRateLimitStore('rl:withdraw:'),
    ...RATE_LIMIT_TIERS.withdrawal, // 5 / hour
    message: { 
        success: false,
        message: "Too many withdrawal requests. Please wait before trying again."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip)
});

// ==================== GENERAL API RATE LIMITER ====================

// General API rate limiter for all other endpoints
export const apiLimiter = rateLimit({
    store: createRateLimitStore('rl:api:'),
    ...RATE_LIMIT_TIERS.api, // 100 / min
    message: { 
        success: false,
        message: "Too many requests. Please slow down."
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ==================== SECURITY MONITOR MIDDLEWARE ====================

/**
 * Security Monitor Middleware
 * Detects suspicious activity like rapid 401s or unusual payloads
 * Logs all security-related events to audit trail
 */
export const securityMonitor = async (req, res, next) => {
    const originalJson = res.json;
    
    res.json = function (data) {
        // Log all failed authentication/authorization attempts
        if (res.statusCode >= 400) {
            if (res.statusCode === 401 || res.statusCode === 403) {
                const logData = {
                    adminId: 'SYSTEM_WATCHDOG',
                    action: 'SECURITY_VIOLATION_ATTEMPT',
                    details: `Blocked ${req.method} request to ${req.originalUrl} from IP ${req.ip}`,
                    ip: req.ip,
                    timestamp: new Date()
                };
                
                // Add extra context for critical endpoints
                if (req.path.includes('/admin') || req.path.includes('/login')) {
                    logData.details += ` | Mobile: ${req.body?.mobile || 'N/A'}`;
                }
                
                AuditLog.create(logData).catch(console.error);
            }
        }
        
        return originalJson.call(this, data);
    };
    
    next();
};

// ==================== IP BLOCKING MIDDLEWARE ====================

/**
 * IP Blocking Middleware
 * Blocks IPs that have been flagged for suspicious activity
 * In production, you'd store blocked IPs in Redis or database
 */
// IP blocking now uses MongoDB via BlockedIP model for persistence across restarts

export const ipBlocker = async (req, res, next) => {
    try {
        const mongoose = (await import('mongoose')).default;
        const BlockedIP = mongoose.model('BlockedIP');
        const blocked = await BlockedIP.findOne({ ip: req.ip, active: true }).lean();
        if (blocked) {
            console.warn('🚫 BLOCKED IP attempted access:', req.ip);
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }
    } catch { /* DB unavailable — fail open to avoid locking out legitimate users */ }
    next();
};

// Function to block an IP (call this from admin panel or automated detection)
export const blockIP = async (ip, reason = 'Suspicious activity') => {
    try {
        const mongoose = (await import('mongoose')).default;
        const BlockedIP = mongoose.model('BlockedIP');
        await BlockedIP.findOneAndUpdate({ ip }, { ip, reason, active: true, blockedAt: new Date() }, { upsert: true });
        console.log('🚫 IP blocked:', ip);
    } catch (e) { console.error('blockIP failed:', e.message); }
};

export const unblockIP = async (ip) => {
    try {
        const mongoose = (await import('mongoose')).default;
        const BlockedIP = mongoose.model('BlockedIP');
        await BlockedIP.findOneAndUpdate({ ip }, { active: false });
        console.log('✅ IP unblocked:', ip);
    } catch (e) { console.error('unblockIP failed:', e.message); }
};
