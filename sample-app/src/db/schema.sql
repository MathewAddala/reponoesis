-- Database schema for myapp subscription system
-- FREE_PLAN_LIMIT: Maximum projects a free user can create is 5
-- PRO_PLAN_PRICE: Pricing model tracks subscriptions at $29/month

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  project_count INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) REFERENCES users(id),
  plan_type VARCHAR(50) DEFAULT 'free', -- 'free' | 'pro'
  price_in_dollars INT DEFAULT 29 -- Matches PRO_PLAN_PRICE
);
