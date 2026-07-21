// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Production Logging Service
 * Outputs structured JSON logs in production for ingestion by ELK/Splunk/CloudWatch.
 * Now includes remote monitoring hooks for proactive alerting.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

// Placeholder for remote monitoring SDKs (e.g. Sentry)
const REMOTE_MONITORING = {
    captureException: (err: any, context?: any) => {
        if (IS_PROD) {
            // This is where Sentry.captureException(err) would go
            // console.log("[REMOTE_MONITOR_SENT]", err.message);
        }
    },
    captureMessage: (msg: string, level: string) => {
        if (IS_PROD && level === 'fatal') {
            // console.log("[REMOTE_ALERT_TRIGGERED]", msg);
        }
    }
};

interface LogEvent {
  level: 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  context?: any;
}

class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public log(event: LogEvent) {
    const timestamp = new Date().toISOString();
    
    if (IS_PROD) {
      try {
          const payload = { 
              timestamp, 
              level: event.level,
              message: event.message,
              context: event.context 
          };
          console.log(JSON.stringify(payload));
          
          if (event.level === 'error' || event.level === 'fatal') {
              REMOTE_MONITORING.captureException(new Error(event.message), event.context);
          }
      } catch (e) {
          console.log(JSON.stringify({
              timestamp,
              level: 'error',
              message: 'Logger failed to serialize context',
              originalMessage: event.message
          }));
      }
    } else {
      const styles = {
        info: 'color: #3b82f6',
        warn: 'color: #f59e0b',
        error: 'color: #ef4444; font-weight: bold',
        fatal: 'background: #ef4444; color: white; font-weight: bold; padding: 2px 4px'
      };
      
      if (typeof console.groupCollapsed === 'function') {
          console.groupCollapsed(`%c[${event.level.toUpperCase()}] ${event.message}`, styles[event.level]);
          if (event.context) console.log(event.context);
          console.groupEnd();
      } else {
          console.log(`[${event.level.toUpperCase()}] ${event.message}`, event.context || '');
      }
    }
  }

  public error(error: Error | string, context?: any) {
    const message = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;
    
    this.log({
      level: 'error',
      message,
      context: { stack, ...context }
    });
  }

  public fatal(message: string, context?: any) {
      this.log({ level: 'fatal', message, context });
      REMOTE_MONITORING.captureMessage(message, 'fatal');
  }

  public info(message: string, context?: any) {
    this.log({ level: 'info', message, context });
  }
  
  public warn(message: string, context?: any) {
    this.log({ level: 'warn', message, context });
  }
}

export const logger = Logger.getInstance();