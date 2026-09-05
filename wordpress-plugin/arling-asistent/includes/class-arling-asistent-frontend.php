<?php
/**
 * Front-end: enqueues the ARLing Asistent widget script, and only that
 * script. Nothing is loaded from ARLing's servers anywhere on the site
 * until a store owner has connected on the settings page; this class is
 * the only place in the plugin that touches the public front end.
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Arling_Asistent_Frontend {

	/** @var Arling_Asistent_Frontend|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'wp_enqueue_scripts', array( $this, 'maybe_enqueue_widget' ) );
		add_filter( 'script_loader_tag', array( $this, 'add_data_attributes' ), 10, 3 );
	}

	/**
	 * Enqueue the widget script, but only when:
	 *  - a tenant id exists (the store has connected), and
	 *  - the widget has not been switched off, and
	 *  - the current page matches the configured display scope.
	 */
	public function maybe_enqueue_widget() {
		if ( is_admin() ) {
			return;
		}

		$tenant_id = get_option( 'arling_asistent_tenant_id', '' );
		if ( empty( $tenant_id ) ) {
			return;
		}

		if ( ! $this->should_show_on_current_page() ) {
			return;
		}

		$endpoint = apply_filters( 'arling_asistent_widget_endpoint', Arling_Asistent_Api::base_url() );
		$endpoint = untrailingslashit( esc_url_raw( $endpoint ) );

		/**
		 * WordPress 6.3+ understands the 'strategy' key below and adds the
		 * defer attribute natively. On WordPress 6.0-6.2 (this plugin's
		 * minimum supported version) an array in this position is simply
		 * treated as a truthy $in_footer argument by WordPress core, so the
		 * script still loads correctly, in the footer, just without the
		 * defer attribute. Either way nothing on the page depends on
		 * blocking, synchronous execution of this script.
		 */
		wp_enqueue_script(
			'arling-asistent-widget',
			$endpoint . '/widget.js',
			array(),
			ARLING_ASISTENT_VERSION,
			array(
				'strategy'  => 'defer',
				'in_footer' => true,
			)
		);
	}

	/**
	 * Whether the widget should appear on the page currently being
	 * rendered, based on the "arling_asistent_display_scope" setting:
	 * 'all' (every front-end page), 'shop' (WooCommerce pages only:
	 * shop, product, cart, checkout, account), or 'disabled'.
	 *
	 * @return bool
	 */
	private function should_show_on_current_page() {
		$scope = get_option( 'arling_asistent_display_scope', 'shop' );

		if ( 'disabled' === $scope ) {
			return false;
		}

		if ( 'all' === $scope ) {
			return true;
		}

		// 'shop': restrict to WooCommerce-related pages only.
		if ( function_exists( 'is_woocommerce' ) && is_woocommerce() ) {
			return true;
		}
		if ( function_exists( 'is_cart' ) && is_cart() ) {
			return true;
		}
		if ( function_exists( 'is_checkout' ) && is_checkout() ) {
			return true;
		}
		if ( function_exists( 'is_account_page' ) && is_account_page() ) {
			return true;
		}

		return false;
	}

	/**
	 * Map the site's active locale to one of the widget's four supported
	 * languages (sk/cs/en/de). Anything else is passed through as-is: the
	 * widget's own normaliseLang() already falls back to Slovak for an
	 * unrecognised code, so there is no need to duplicate that list here.
	 *
	 * @return string Two-letter language code.
	 */
	private function detect_language_from_locale() {
		return strtolower( substr( get_locale(), 0, 2 ) );
	}

	/**
	 * Resolve the "arling_asistent_lang" option to an actual widget
	 * data-lang value, turning "auto" into the site's detected language.
	 *
	 * @return string
	 */
	private function resolve_lang() {
		$lang = get_option( 'arling_asistent_lang', 'auto' );
		if ( 'auto' === $lang ) {
			return $this->detect_language_from_locale();
		}
		return $lang;
	}

	/**
	 * Add data-tenant / data-lang / data-color / data-endpoint (and a
	 * forward-compatible data-position) attributes to our own script tag
	 * only. wp_enqueue_script() has no built-in way to add arbitrary data
	 * attributes, so this is the documented WordPress way to do it.
	 *
	 * @param string $tag    The <script> tag HTML.
	 * @param string $handle The script's registered handle.
	 * @param string $src    The script's src URL.
	 * @return string
	 */
	public function add_data_attributes( $tag, $handle, $src ) {
		if ( 'arling-asistent-widget' !== $handle ) {
			return $tag;
		}

		$tenant_id = get_option( 'arling_asistent_tenant_id', '' );
		if ( empty( $tenant_id ) ) {
			return $tag;
		}

		$color    = get_option( 'arling_asistent_color', 'auto' );
		$position = get_option( 'arling_asistent_position', 'bottom-right' );
		$endpoint = apply_filters( 'arling_asistent_widget_endpoint', Arling_Asistent_Api::base_url() );

		$attributes = sprintf(
			' data-tenant="%1$s" data-lang="%2$s" data-color="%3$s" data-position="%4$s" data-endpoint="%5$s"',
			esc_attr( $tenant_id ),
			esc_attr( $this->resolve_lang() ),
			esc_attr( $color ),
			esc_attr( $position ),
			esc_url( untrailingslashit( $endpoint ) )
		);

		return str_replace( ' src=', $attributes . ' src=', $tag );
	}
}
