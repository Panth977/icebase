import { collection, desc, f, index } from '@panth977/icebase/schema';

export const users = collection('users', {
  fields: {
    email: f.string(),
    displayName: f.string({ max: 80 }),
    role: f.enum(['admin', 'member']),
    createdAt: f.timestamp(),
    photoUrl: f.optional(f.string()),
    address: f.optional(f.map({ city: f.string(), pin: f.string() })),
  },
  // Nested fields are key arrays: ['address', 'city'].
  indexes: [index('email'), index('role', desc('createdAt')), index(['address', 'city'])],
});
