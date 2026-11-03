import { z } from 'zod';

/** `/something/:id` */
export const idParams = z.object({ id: z.coerce.number().int().positive() });
