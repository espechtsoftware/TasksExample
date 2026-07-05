/**
 * The product catalog: what a customer can buy and what each tier entitles
 * them to. Kept as plain data so the purchase tool, the quota checks, and
 * the dataset size limit all read from one place.
 */

export interface Product {
  id: 'basic' | 'standard' | 'pro';
  name: string;
  priceUsd: number;
  description: string;
  /** How many training runs per calendar day (UTC). */
  trainingsPerDay: number;
  /** Lifetime cap on training runs, or null for unlimited within the validity window. */
  totalTrainings: number | null;
  /** Hard cap on an uploaded dataset, enforced before anything touches disk. */
  maxDatasetBytes: number;
  /** Days the entitlement stays active after purchase. */
  validDays: number;
}

const MB = 1024 * 1024;

export const PRODUCTS: Record<Product['id'], Product> = {
  basic: {
    id: 'basic',
    name: 'Basic — one-time training',
    priceUsd: 29,
    description: 'Train one model on one dataset. Good for a single experiment.',
    trainingsPerDay: 1,
    totalTrainings: 1,
    maxDatasetBytes: 1 * MB,
    validDays: 7
  },
  standard: {
    id: 'standard',
    name: 'Standard — retrain up to twice a day',
    priceUsd: 99,
    description: 'Retrain as your data evolves: up to 2 training runs per day for 30 days.',
    trainingsPerDay: 2,
    totalTrainings: null,
    maxDatasetBytes: 5 * MB,
    validDays: 30
  },
  pro: {
    id: 'pro',
    name: 'Pro — high-frequency retraining',
    priceUsd: 249,
    description: 'Up to 10 training runs per day for 30 days, with the largest dataset allowance.',
    trainingsPerDay: 10,
    totalTrainings: null,
    maxDatasetBytes: 25 * MB,
    validDays: 30
  }
};

export function getProduct(id: string): Product | undefined {
  return (PRODUCTS as Record<string, Product>)[id];
}
