// billing.test.mjs
// Billing GraphQL API (appSubscriptionCreate): the exact mutation/variables
// shape for each paid plan, and createRecurringCharge's request/response
// handling (confirmationUrl on success, thrown error on userErrors or a
// non-ok HTTP response).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_DEFS,
  FREE_PLAN,
  buildAppSubscriptionCreateVariables,
  createRecurringCharge,
  conversationsForPlan,
  APP_SUBSCRIPTION_CREATE_MUTATION,
} from '../shopify-worker/src/billing.js';

const SHOP = 'my-shop.myshopify.com';
const TOKEN = 'shpat_live_token';

test('PLAN_DEFS matches the required pricing: Starter 19 USD/1000 conversations, Pro 39 USD/5000; free plan needs no charge', () => {
  assert.equal(PLAN_DEFS.starter.amount, 19);
  assert.equal(PLAN_DEFS.starter.currencyCode, 'USD');
  assert.equal(PLAN_DEFS.starter.conversations, 1000);
  assert.equal(PLAN_DEFS.pro.amount, 39);
  assert.equal(PLAN_DEFS.pro.currencyCode, 'USD');
  assert.equal(PLAN_DEFS.pro.conversations, 5000);
  assert.equal(FREE_PLAN.amount, 0);
  assert.equal(FREE_PLAN.conversations, 100);
});

test('APP_SUBSCRIPTION_CREATE_MUTATION declares the appSubscriptionCreate mutation with the fields this module relies on', () => {
  assert.match(APP_SUBSCRIPTION_CREATE_MUTATION, /appSubscriptionCreate/);
  assert.match(APP_SUBSCRIPTION_CREATE_MUTATION, /confirmationUrl/);
  assert.match(APP_SUBSCRIPTION_CREATE_MUTATION, /userErrors/);
  assert.match(APP_SUBSCRIPTION_CREATE_MUTATION, /appSubscription\s*\{\s*id\s*\}/);
});

test('buildAppSubscriptionCreateVariables builds the exact lineItems/pricing shape for the Starter plan', () => {
  const variables = buildAppSubscriptionCreateVariables('starter', { returnUrl: 'https://app/return', test: true });
  assert.equal(variables.name, 'ARLing Asistent Starter');
  assert.equal(variables.returnUrl, 'https://app/return');
  assert.equal(variables.test, true);
  assert.equal(variables.lineItems.length, 1);
  const pricing = variables.lineItems[0].plan.appRecurringPricingDetails;
  assert.equal(pricing.price.amount, 19);
  assert.equal(pricing.price.currencyCode, 'USD');
  assert.equal(pricing.interval, 'EVERY_30_DAYS');
});

test('buildAppSubscriptionCreateVariables builds the exact lineItems/pricing shape for the Pro plan', () => {
  const variables = buildAppSubscriptionCreateVariables('pro', { returnUrl: 'https://app/return' });
  assert.equal(variables.name, 'ARLing Asistent Pro');
  assert.equal(variables.test, false);
  const pricing = variables.lineItems[0].plan.appRecurringPricingDetails;
  assert.equal(pricing.price.amount, 39);
  assert.equal(pricing.price.currencyCode, 'USD');
});

test('buildAppSubscriptionCreateVariables throws for an unknown plan key', () => {
  assert.throws(() => buildAppSubscriptionCreateVariables('enterprise', { returnUrl: 'https://x' }), /unknown_plan_enterprise/);
});

test('conversationsForPlan maps plan keys to the ARLing tenant quota (matching worker/src/tenants.js PLANS in the parent product)', () => {
  assert.equal(conversationsForPlan('starter'), 1000);
  assert.equal(conversationsForPlan('pro'), 5000);
  assert.equal(conversationsForPlan('free'), 100);
  assert.equal(conversationsForPlan('anything-else'), 100);
});

test('createRecurringCharge posts the mutation to the shop Admin GraphQL endpoint with the access token header and returns confirmationUrl', async () => {
  let capturedUrl;
  let capturedOptions;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ data: { appSubscriptionCreate: { appSubscription: { id: 'gid://shopify/AppSubscription/1' }, confirmationUrl: 'https://my-shop.myshopify.com/admin/charges/1', userErrors: [] } } }),
    };
  };

  const result = await createRecurringCharge(SHOP, TOKEN, 'starter', { returnUrl: 'https://app/return', test: true, fetchImpl });

  assert.match(capturedUrl, new RegExp(`^https://${SHOP}/admin/api/`));
  assert.equal(capturedOptions.headers['X-Shopify-Access-Token'], TOKEN);
  const sentBody = JSON.parse(capturedOptions.body);
  assert.equal(sentBody.variables.name, 'ARLing Asistent Starter');
  assert.equal(sentBody.variables.test, true);

  assert.equal(result.confirmationUrl, 'https://my-shop.myshopify.com/admin/charges/1');
  assert.equal(result.subscriptionId, 'gid://shopify/AppSubscription/1');
});

test('createRecurringCharge throws when Shopify returns userErrors', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: { appSubscriptionCreate: { appSubscription: null, confirmationUrl: null, userErrors: [{ field: ['returnUrl'], message: 'is invalid' }] } } }),
  });
  await assert.rejects(
    createRecurringCharge(SHOP, TOKEN, 'pro', { returnUrl: 'not-a-url', fetchImpl }),
    /billing_user_error/
  );
});

test('createRecurringCharge throws on a non-ok HTTP response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(createRecurringCharge(SHOP, TOKEN, 'pro', { returnUrl: 'https://x', fetchImpl }), /billing_request_failed_401/);
});
