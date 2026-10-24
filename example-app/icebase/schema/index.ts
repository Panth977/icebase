import { defineSchema } from 'icebase/schema';
import { users } from './users';
import { products } from './products';
import { orders } from './orders';

export { users, products, orders };
export const schema = defineSchema({ users, products, orders });
