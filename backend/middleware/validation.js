// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { z } from 'zod';

export const validate = (schema) => (req, res, next) => {
  try {
    schema.parse(req.body);
    next();
  } catch (err) {
    return res.status(400).json({ message: err.errors[0].message });
  }
};

export const schemas = {
  login: z.object({
    mobile: z.string().regex(/^[0-9]{10}$/, "Invalid Mobile"),
    password: z.string().min(6)
  }),
  register: z.object({
    username: z.string().min(3, "Username must be at least 3 characters"),
    mobile: z.string().regex(/^[0-9]{10}$/, "Invalid Mobile"),
    password: z.string().min(6, "Password must be at least 6 characters")
  }),
  bet: z.object({
    userId: z.string(),
    cycleId: z.string(),
    amount: z.number().int().positive(),
    side: z.enum(['DELHI', 'BOMBAY'])
  }),
  paymentOrder: z.object({
    userId: z.string(),
    type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
    amount: z.number().int().min(100)
  })
};
