/*
 * billing.js
 *
 * Recurring application charges via the Shopify Billing GraphQL API
 * (`appSubscriptionCreate`), for the two paid plans. The free plan needs no
 * charge at all: it is just the shop's `plan` column staying 'free' with
 * the ARLing tenant's own default 100-conversation quota (see the parent
 * product's worker/src/tenants.js DEFAULT_FREE_QUOTA), so there is nothing
 * billing-related to call for it.
 *
 * Plan <-> ARLing quota mapping matches the parent product's PLANS/quotas
 * exactly (worker/src/tenants.js): free=100, starter=1000, pro=5000
 * conversations/month. Pricing here (19 USD / 39 USD) is the Shopify listing
 * price; the parent product's own Stripe pricing (README: "19 EUR / 39 EUR")
 * is for direct arling.sk customers and is intentionally not reused here,
 * since Shopify requires its own Billing API rather than an external
 * processor for App Store apps (see README "Research notes" for the cited
 * shopify.dev requirement).
 *
 * Note on Shopify App Pricing: shopify.dev now recommends declaring prices
 * once in the Partner Dashboard ("Shopify App Pricing") for new public
 * apps, rather than calling appSubscriptionCreate directly, and Shopify
 * then bills the merchant without any app code at all. This module
 * implements the GraphQL Billing API path instead because the task calls
 * for it explicitly and it works, is fully testable locally, and does not
 * require the Partner Dashboard app (which does not exist yet) to already
 * have pricing configured; see README "known gaps" for the tradeoff.
 */

export const PLAN_DEFS = {
  starter: { key: 'starter', name: 'ARLing Asistent Starter', amount: 19, currencyCode: 'USD', conversations: 1000 },
  pro: { key: 'pro', name: 'ARLing Asistent Pro', amount: 39, currencyCode: 'USD', conversations: 5000 },
};

export const FREE_PLAN = { key: 'free', name: 'ARLing Asistent Free', amount: 0, currencyCode: 'USD', conversations: 100 };

export const BILLING_API_VERSION = '2025-01';

export const APP_SUBSCRIPTION_CREATE_MUTATION = `
  mutation AppSubscriptionCreate(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
      appSubscription { id }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

/** Build the {query, variables} pair for one plan's appSubscriptionCreate call. Pure/synchronous so the exact payload shape is unit-testable without any network call. */
export function buildAppSubscriptionCreateVariables(planKey, { returnUrl, test = false } = {}) {
  const plan = PLAN_DEFS[planKey];
  if (!plan) throw new Error(`unknown_plan_${planKey}`);
  return {
    name: plan.name,
    returnUrl,
    test,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: plan.amount, currencyCode: plan.currencyCode },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
    ],
  };
}

/** POST the Admin GraphQL appSubscriptionCreate mutation for one shop/plan. Returns {confirmationUrl, subscriptionId} on success; throws on a GraphQL/user error so callers can surface it as a 4xx to the admin page. */
export async function createRecurringCharge(shopDomain, accessToken, planKey, { returnUrl, test = false, fetchImpl = fetch, apiVersion = BILLING_API_VERSION } = {}) {
  const variables = buildAppSubscriptionCreateVariables(planKey, { returnUrl, test });
  const res = await fetchImpl(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: APP_SUBSCRIPTION_CREATE_MUTATION, variables }),
  });
  if (!res.ok) {
    throw new Error(`billing_request_failed_${res.status}`);
  }
  const body = await res.json();
  const result = body && body.data && body.data.appSubscriptionCreate;
  const userErrors = (result && result.userErrors) || [];
  if (userErrors.length) {
    const err = new Error(`billing_user_error_${userErrors[0].message}`);
    err.userErrors = userErrors;
    throw err;
  }
  if (!result || !result.confirmationUrl) {
    throw new Error('billing_missing_confirmation_url');
  }
  return { confirmationUrl: result.confirmationUrl, subscriptionId: result.appSubscription && result.appSubscription.id };
}

/** Map a Shopify plan key to the ARLing tenant monthly conversation quota it should carry (informational: the actual per-tenant quota lives in the ARLing tenants table and is not changed by this app yet, see README "known gaps" on plan upgrades not yet round-tripping to the tenant's monthly_quota). */
export function conversationsForPlan(planKey) {
  if (planKey === 'starter') return PLAN_DEFS.starter.conversations;
  if (planKey === 'pro') return PLAN_DEFS.pro.conversations;
  return FREE_PLAN.conversations;
}
