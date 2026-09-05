<?php
/**
 * Plugin Name:       ARLing Asistent for WooCommerce
 * Plugin URI:        https://arling.sk/asistent/
 * Description:       AI shopping assistant chat widget that answers customer questions from your own WooCommerce product feed. No conversation content is stored.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * WC requires at least: 8.0
 * WC tested up to:   9.4
 * Author:            ARLing s. r. o.
 * Author URI:        https://arling.sk
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       arling-asistent
 * Domain Path:       /languages
 *
 * ARLing Asistent for WooCommerce, a plugin to connect a WooCommerce store
 * to the ARLing Asistent chat widget service.
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
 * ARLing Asistent settings page after ticking the consent checkbox, sends
 * three pieces of data to the ARLing Asistent API (operated by ARLing
 * s. r. o., Bratislava, Slovakia, https://arling.sk):
 *
 *   1. The store's public WooCommerce Store API product feed URL
 *      ({home_url}/wp-json/wc/store/v1/products?per_page=100). This is
 *      already public data your store serves to any visitor's browser.
 *   2. The site's domain name.
 *   3. The administrator e-mail address entered on the settings screen.
 *
 * No customer data and no order data is ever sent by this plugin. Once
 * connected, the front-end widget script (loaded from the same service,
 * see includes/class-arling-asistent-frontend.php) talks directly to that
 * service to answer shopper questions; the service does not store
 * conversation content, only daily aggregate counters (see
 * https://arling.sk/asistent/#gdpr for the data processing agreement).
 *
 * Nothing is sent anywhere until an administrator connects the store, and
 * the front-end widget script is only ever loaded after that connection
 * exists (see Arling_Asistent_Frontend::maybe_enqueue_widget()).
 */

define( 'ARLING_ASISTENT_VERSION', '0.1.0' );
define( 'ARLING_ASISTENT_FILE', __FILE__ );
define( 'ARLING_ASISTENT_DIR', plugin_dir_path( __FILE__ ) );
define( 'ARLING_ASISTENT_URL', plugin_dir_url( __FILE__ ) );

/**
 * Default base URL of the ARLing Asistent API and widget script. Both the
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
		esc_html__( 'ARLing Asistent for WooCommerce requires WooCommerce to be installed and active.', 'arling-asistent' ) .
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

/*
 * There is no deactivation hook here on purpose: deactivating (as opposed
 * to deleting) the plugin deliberately leaves all stored settings in place,
 * so a merchant who briefly deactivates it while troubleshooting another
 * plugin does not lose their tenant connection. Options are only ever
 * removed by uninstall.php, and only when the plugin is deleted from
 * wp-admin.
 */
