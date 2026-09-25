<?php
/**
 * Plugin Name:       ARLing Shopping Assistant for WooCommerce
 * Plugin URI:        https://arling.sk/asistent/
 * Description:       AI chatbot for WooCommerce that answers shopper questions from your own product catalogue. Switch it on inside WordPress in about a minute, no account or API key. No conversation content is stored.
 * Version:           0.4.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * WC requires at least: 8.0
 * WC tested up to:   11.1
 * Author:            ARLing s. r. o.
 * Author URI:        https://arling.sk
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       arling-asistent
 * Domain Path:       /languages
 *
 * ARLing Shopping Assistant for WooCommerce, a plugin to connect a WooCommerce store
 * to the ARLing Shopping Assistant chat widget service.
 * Copyright (C) 2026  ARLing s. r. o.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License, version 2, as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see https://www.gnu.org/licenses/gpl-2.0.html
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Do not load this file directly.
}

/**
 * -----------------------------------------------------------------------
 * External service disclosure (see also readme.txt "External services").
 * -----------------------------------------------------------------------
 * This plugin, when an administrator explicitly clicks "Connect" on the
 * ARLing Shopping Assistant settings page after ticking the consent checkbox, sends
 * three pieces of data to the ARLing Shopping Assistant API (operated by ARLing
 * s. r. o., Bratislava, Slovakia, https://arling.sk):
 *
 *   1. The store's public WooCommerce Store API product list URL
 *      (get_rest_url() + wc/store/v1/products?per_page=100, for example
 *      https://example.com/wp-json/wc/store/v1/products?per_page=100). This
 *      is already public data your store serves to any visitor's browser.
 *   2. The site's domain name.
 *   3. The administrator e-mail address entered on the settings screen.
 *
 * The same three items are sent again only when the administrator clicks
 * "Try again" after a failed setup. No customer data and no order data is
 * ever sent by this plugin.
 *
 * While connected, the plugin also asks the same service for the
 * assistant's status (GET /v1/tenants/{id}/status: setup state, plan,
 * conversations used this month). This happens when the settings page is
 * opened and, through WP-Cron, at most twice a day, so the admin can be
 * warned before the free monthly limit runs out. The request carries only
 * the tenant id in its URL.
 *
 * Once connected, the widget script (loaded from the same service, see
 * includes/class-arling-asistent-frontend.php) talks directly to that
 * service to answer shopper questions, on the storefront and in the
 * "Try it now" preview on the settings page; the service does not store
 * conversation content, only daily aggregate counters (see
 * https://arling.sk/asistent/#gdpr for the data processing agreement).
 *
 * Nothing is sent anywhere until an administrator connects the store, and
 * the widget script is only ever loaded after that connection exists (see
 * Arling_Asistent_Frontend::maybe_enqueue_widget() and
 * Arling_Asistent_Admin::enqueue_admin_assets()).
 */

define( 'ARLING_ASISTENT_VERSION', '0.4.0' );
define( 'ARLING_ASISTENT_FILE', __FILE__ );
define( 'ARLING_ASISTENT_DIR', plugin_dir_path( __FILE__ ) );
define( 'ARLING_ASISTENT_URL', plugin_dir_url( __FILE__ ) );

/**
 * Default base URL of the ARLing Shopping Assistant API and widget script. Both the
 * onboarding API calls and the front-end widget src share this default;
 * site owners (or ARLing, for a future deployment on a different domain)
 * can override either independently with the filters exposed below.
 */
define( 'ARLING_ASISTENT_DEFAULT_API_BASE', 'https://arling-asistent.arling.workers.dev' );

/**
 * Stripe Payment Link URLs for the Starter (19 EUR/month) and Pro
 * (39 EUR/month) plans, shown as "Upgrade" buttons on the settings page
 * (see Arling_Asistent_Admin::render_upgrade_section()). Empty by default
 * (STRIPE_LINK_STARTER / STRIPE_LINK_PRO placeholders): ARLing has not
 * created the Stripe product/prices yet, see
 * products/arling-asistent/README.md "Platby cez Stripe". Until a link is
 * set (here, or via the `arling_asistent_stripe_link_starter` /
 * `arling_asistent_stripe_link_pro` filters below), the corresponding
 * button shows "coming soon" instead of a link.
 */
define( 'ARLING_ASISTENT_DEFAULT_STRIPE_LINK_STARTER', 'https://buy.stripe.com/5kQcMZ1fA6tZaoWaOh4ko03' );
define( 'ARLING_ASISTENT_DEFAULT_STRIPE_LINK_PRO', 'https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04' );

/**
 * Stripe customer portal (change card, cancel a paid plan). A public login
 * page hosted by Stripe; the merchant signs in with the e-mail they paid with.
 */
define( 'ARLING_ASISTENT_STRIPE_PORTAL', 'https://billing.stripe.com/p/login/3cIaER9M63hNeFcg8B4ko00' );

/** Free plan limit, shown before connecting. The live number always comes from the status API. */
define( 'ARLING_ASISTENT_FREE_CONVERSATIONS', 100 );

/** WP-Cron hook that refreshes the stored status (plan, usage, setup state) twice a day while connected. */
define( 'ARLING_ASISTENT_CRON_HOOK', 'arling_asistent_status_check' );

require_once ARLING_ASISTENT_DIR . 'includes/class-arling-asistent-api.php';
require_once ARLING_ASISTENT_DIR . 'includes/class-arling-asistent-admin.php';
require_once ARLING_ASISTENT_DIR . 'includes/class-arling-asistent-frontend.php';

/**
 * Declare compatibility with WooCommerce High-Performance Order Storage
 * (custom order tables). This plugin never reads or writes order data at
 * all, so it is compatible by construction; we still declare it explicitly
 * because WooCommerce otherwise lists every active plugin as "unknown"
 * on the HPOS compatibility screen.
 */
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', ARLING_ASISTENT_FILE, true );
		}
	}
);

/**
 * No manual translation loading call here on purpose: this plugin's text
 * domain "arling-asistent" matches its wordpress.org slug, and WordPress
 * 4.6+ auto-loads translations for such plugins (from translate.wordpress.org
 * once approved, or from /languages as a fallback) without a
 * load_plugin_textdomain() call. Calling it explicitly is unnecessary and
 * flagged by the wordpress.org Plugin Check tool as a discouraged function.
 */

/**
 * Bail out (with an admin notice) if WooCommerce is not active. The
 * settings page lives under the WooCommerce admin menu and the feed URL
 * this plugin sends relies on the WooCommerce Store API, so there is
 * nothing useful this plugin can do without it.
 */
function arling_asistent_woocommerce_missing_notice() {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}
	echo '<div class="notice notice-error"><p>' .
		esc_html__( 'ARLing Shopping Assistant for WooCommerce requires WooCommerce to be installed and active.', 'arling-asistent' ) .
		'</p></div>';
}

function arling_asistent_init_plugin() {
	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action( 'admin_notices', 'arling_asistent_woocommerce_missing_notice' );
		return;
	}

	Arling_Asistent_Admin::instance();
	Arling_Asistent_Frontend::instance();
}
add_action( 'plugins_loaded', 'arling_asistent_init_plugin' );

/**
 * On activation, remember (for one minute) that the next admin page load
 * should open the setup screen. Up to 0.2.1 activating the plugin changed
 * nothing visible: the setup screen sat under WooCommerce > ARLing Shopping
 * Assistant with no link, notice or redirect pointing to it, and most
 * people who installed the plugin never found it. The redirect itself
 * (Arling_Asistent_Admin::maybe_activation_redirect()) runs once, only for a
 * single-plugin activation, and never once the store is connected.
 */
function arling_asistent_activate() {
	if ( get_option( 'arling_asistent_tenant_id', '' ) ) {
		return;
	}
	set_transient( 'arling_asistent_activation_redirect', 1, MINUTE_IN_SECONDS );
}
register_activation_hook( __FILE__, 'arling_asistent_activate' );

/**
 * Deactivation only stops the twice-daily status check. All settings,
 * including the connection, stay in place on purpose, so a merchant who
 * briefly deactivates the plugin while troubleshooting another one does not
 * lose it. Options are only removed by uninstall.php, when the plugin is
 * deleted from wp-admin.
 */
function arling_asistent_deactivate() {
	wp_clear_scheduled_hook( ARLING_ASISTENT_CRON_HOOK );
}
register_deactivation_hook( __FILE__, 'arling_asistent_deactivate' );

/**
 * "Set up" (before connecting) or "Settings" link on the Plugins screen, so
 * the setup screen is one click away from where the plugin was activated.
 *
 * @param string[] $links Existing action links.
 * @return string[]
 */
function arling_asistent_action_links( $links ) {
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return $links;
	}
	$label = get_option( 'arling_asistent_tenant_id', '' )
		? __( 'Settings', 'arling-asistent' )
		: __( 'Set up', 'arling-asistent' );
	array_unshift(
		$links,
		'<a href="' . esc_url( admin_url( 'admin.php?page=arling-asistent' ) ) . '">' . esc_html( $label ) . '</a>'
	);
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'arling_asistent_action_links' );
