<?php
/**
 * Settings page under WooCommerce > ARLing Shopping Assistant: connect the
 * store, show whether the assistant is being built, ready or stuck (and why),
 * let the merchant try it right on the settings page, show plan and usage,
 * and hold the widget settings. Every state-changing action goes through
 * admin-post.php with a nonce and a current_user_can( 'manage_woocommerce' )
 * capability check; nothing is ever wired to a bare GET request.
 *
 * Why this screen looks the way it does (0.3.0): up to 0.2.1 the plugin was
 * downloaded but almost never left active. Activation changed nothing
 * visible, the setup screen had no link to it, a failed setup showed one
 * sentence with no reason and no way to retry, a store with no products
 * became "Ready" with an assistant that knew nothing, and a ready assistant
 * sat on WooCommerce pages only, with no pointer to where it could be seen.
 * Each of those is handled below.
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Arling_Asistent_Admin {

	/** @var Arling_Asistent_Admin|null */
	private static $instance = null;

	/** How long a fetched tenant status is cached before the settings page fetches it again (seconds). Never cached while the assistant is still being built. */
	const STATUS_CACHE_TTL = 30;

	/** Auto-refresh interval of the settings page while the product list is being read (seconds). */
	const PENDING_REFRESH_SECONDS = 5;

	/** Usage share (percent) from which the upgrade buttons become primary and the admin gets a notice. */
	const USAGE_WARNING_PERCENT = 80;

	/** User meta key holding the notices this user has hidden. */
	const DISMISSED_META = 'arling_asistent_dismissed';

	/** @var string Hook suffix of the settings page, set in register_menu(). */
	private $page_hook = '';

	/** @var bool Whether get_current_status() already ran in this request. */
	private $status_fetched = false;

	/** @var array|null Status for this request (normalised), or null. */
	private $status = null;

	/** @var array|null The failed API result, when the status could not be fetched. */
	private $status_failure = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_menu', array( $this, 'register_menu' ) );
		add_action( 'admin_init', array( $this, 'maybe_activation_redirect' ) );
		add_action( 'admin_init', array( $this, 'ensure_status_cron' ) );
		add_action( 'admin_notices', array( $this, 'render_admin_notices' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
		add_action( ARLING_ASISTENT_CRON_HOOK, array( __CLASS__, 'cron_status_check' ) );

		add_action( 'admin_post_arling_asistent_connect', array( $this, 'handle_connect' ) );
		add_action( 'admin_post_arling_asistent_retry', array( $this, 'handle_retry' ) );
		add_action( 'admin_post_arling_asistent_disconnect', array( $this, 'handle_disconnect' ) );
		add_action( 'admin_post_arling_asistent_save_settings', array( $this, 'handle_save_settings' ) );
		add_action( 'admin_post_arling_asistent_refresh_status', array( $this, 'handle_refresh_status' ) );
		add_action( 'admin_post_arling_asistent_dismiss', array( $this, 'handle_dismiss' ) );
	}

	public function register_menu() {
		$this->page_hook = (string) add_submenu_page(
			'woocommerce',
			__( 'ARLing Shopping Assistant', 'arling-asistent' ),
			__( 'ARLing Shopping Assistant', 'arling-asistent' ),
			'manage_woocommerce',
			'arling-asistent',
			array( $this, 'render_page' )
		);
	}

	// -------------------------------------------------------------------
	// Shared helpers
	// -------------------------------------------------------------------

	private function settings_url() {
		return admin_url( 'admin.php?page=arling-asistent' );
	}

	private function tenant_id() {
		return (string) get_option( 'arling_asistent_tenant_id', '' );
	}

	/**
	 * The store's public WooCommerce Store API product list, built with
	 * get_rest_url() so it also works with "Plain" permalinks
	 * (?rest_route=/wc/store/v1/products) and a custom REST prefix. Up to
	 * 0.2.1 this was "/wp-json/..." glued to home_url(), which answers 404 on
	 * a site with plain permalinks, so the assistant could never be built there.
	 */
	private function default_feed_url() {
		return add_query_arg( 'per_page', 100, get_rest_url( null, 'wc/store/v1/products' ) );
	}

	private function default_domain() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		return $host ? $host : '';
	}

	/** Number of published WooCommerce products on this site. */
	private function published_product_count() {
		$counts = wp_count_posts( 'product' );
		return ( $counts && isset( $counts->publish ) ) ? (int) $counts->publish : 0;
	}

	/**
	 * Why our service cannot read this site's products from the internet, or
	 * '' when nothing speaks against it. People often try a new plugin on a
	 * local or staging copy first (Local uses *.local, DDEV *.ddev.site, many
	 * tools *.test, WordPress Playground runs inside the browser); up to 0.2.1
	 * such a site got a raw API validation message after clicking Connect, or
	 * a setup that failed later with no explanation.
	 *
	 * Filter `arling_asistent_unreachable_reason` can override the result,
	 * for example for a public site on an unusual domain.
	 *
	 * @return string Plain text, escaped on output.
	 */
	private function site_reachability_problem() {
		$host = strtolower( trim( (string) wp_parse_url( home_url(), PHP_URL_HOST ), '[]' ) );
		$demo = 'https://arling.sk/asistent/';
		$reason = '';

		if ( '' === $host ) {
			$reason = __( 'Could not determine this site\'s domain from its WordPress address.', 'arling-asistent' );
		} elseif ( 'playground.wordpress.net' === $host || self::ends_with( $host, '.playground.wordpress.net' ) ) {
			$reason = sprintf(
				/* translators: %s: URL of the public demo shop. */
				__( 'WordPress Playground runs only inside your browser, so our service cannot read its products from the internet. Install the plugin on your live shop, or try the assistant on our demo shop: %s', 'arling-asistent' ),
				$demo
			);
		} else {
			$is_local = ( 'localhost' === $host ) || ( false === strpos( $host, '.' ) && false === strpos( $host, ':' ) );
			foreach ( array( '.localhost', '.local', '.test', '.invalid', '.example', '.lan', '.home', '.internal', '.corp', '.private', '.ddev.site', '.lndo.site' ) as $suffix ) {
				if ( self::ends_with( $host, $suffix ) ) {
					$is_local = true;
				}
			}
			if ( ! $is_local && filter_var( $host, FILTER_VALIDATE_IP ) ) {
				$is_local = ! filter_var( $host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
			}
			if ( $is_local ) {
				$reason = sprintf(
					/* translators: 1: this site's host name, 2: URL of the public demo shop. */
					__( 'This site runs at %1$s, a local, staging or private address that our service cannot reach from the internet. The assistant reads your product list over the internet, so connect it on your live shop. Meanwhile you can try the assistant on our demo shop: %2$s', 'arling-asistent' ),
					$host,
					$demo
				);
			}
		}

		return (string) apply_filters( 'arling_asistent_unreachable_reason', $reason, $host );
	}

	private static function ends_with( $haystack, $needle ) {
		$length = strlen( $needle );
		return $length > 0 && strlen( $haystack ) >= $length && substr( $haystack, -$length ) === $needle;
	}

	/**
	 * Store a one-time admin notice for the current user and redirect back
	 * to the settings page. Redirect-after-POST avoids a resubmission
	 * warning on refresh and keeps $_POST out of the browser history.
	 *
	 * @param string $type    'success' or 'error'.
	 * @param string $message Plain text, escaped on output.
	 */
	private function redirect_with_notice( $type, $message ) {
		set_transient(
			'arling_asistent_notice_' . get_current_user_id(),
			array(
				'type'    => $type,
				'message' => $message,
			),
			60
		);
		wp_safe_redirect( $this->settings_url() );
		exit;
	}

	private function require_capability_and_nonce( $action, $nonce_field ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'arling-asistent' ), 403 );
		}
		check_admin_referer( $action, $nonce_field );
	}

	/**
	 * Human sentence for a failed POST /v1/tenants call.
	 *
	 * @param array $result Normalised result from Arling_Asistent_Api.
	 * @return string
	 */
	private function connect_error_message( $result ) {
		$error = isset( $result['error'] ) ? (string) $result['error'] : '';
		if ( 'request_failed' === $error ) {
			return sprintf(
				/* translators: 1: error detail from WordPress, 2: host name of the ARLing service. */
				__( 'Your server could not reach our service (%1$s). If your host blocks outgoing connections, ask them to allow HTTPS requests to %2$s, then try again.', 'arling-asistent' ),
				isset( $result['message'] ) ? $result['message'] : '',
				(string) wp_parse_url( Arling_Asistent_Api::base_url(), PHP_URL_HOST )
			);
		}
		if ( 'rate_limited' === $error ) {
			return __( 'Too many connection attempts from this server in the last hour. Please try again in an hour.', 'arling-asistent' );
		}
		$detail = isset( $result['message'] ) && $result['message'] ? $result['message'] : ( $error ? $error : __( 'unknown error', 'arling-asistent' ) );
		return sprintf(
			/* translators: %s: error detail returned by the ARLing Shopping Assistant API. */
			__( 'Could not connect to ARLing Shopping Assistant: %s', 'arling-asistent' ),
			$detail
		);
	}

	// -------------------------------------------------------------------
	// Status: fetch, normalise, remember
	// -------------------------------------------------------------------

	/**
	 * Keep only the fields this plugin uses, typed, so a stored copy can be
	 * trusted on every admin and storefront page without re-validating.
	 *
	 * @param mixed $data Decoded status API body.
	 * @return array
	 */
	public static function normalise_status( $data ) {
		$data  = is_array( $data ) ? $data : array();
		$quota = isset( $data['monthly_quota'] ) ? (int) $data['monthly_quota'] : 0;
		if ( isset( $data['conversations_used'] ) ) {
			$used = (int) $data['conversations_used'];
		} else {
			$used = isset( $data['used_this_month'] ) ? (int) $data['used_this_month'] : 0;
		}
		if ( isset( $data['usage_percent'] ) ) {
			$percent = (int) $data['usage_percent'];
		} else {
			$percent = $quota > 0 ? (int) min( 100, floor( $used * 100 / $quota ) ) : 0;
		}
		$last_ingest = '';
		if ( ! empty( $data['last_ingest'] ) ) {
			$last_ingest = sanitize_text_field( (string) $data['last_ingest'] );
		} elseif ( ! empty( $data['last_ingested_at'] ) ) {
			$last_ingest = sanitize_text_field( (string) $data['last_ingested_at'] );
		}

		return array(
			'status'        => isset( $data['status'] ) ? sanitize_key( (string) $data['status'] ) : 'unknown',
			'plan'          => isset( $data['plan'] ) ? sanitize_key( (string) $data['plan'] ) : 'free',
			'monthly_quota' => $quota,
			'used'          => $used,
			'usage_percent' => max( 0, min( 100, $percent ) ),
			'period_end'    => isset( $data['period_end'] ) ? sanitize_text_field( (string) $data['period_end'] ) : '',
			'product_count' => isset( $data['product_count'] ) ? (int) $data['product_count'] : null,
			'last_ingest'   => $last_ingest,
			'last_error'    => ! empty( $data['last_error'] ) ? sanitize_key( (string) $data['last_error'] ) : '',
			'fetched_at'    => time(),
		);
	}

	/**
	 * Remember the latest status for the admin notices and the storefront
	 * (which hides a bubble that cannot answer). Never a remote call.
	 *
	 * @param array $status Normalised status.
	 */
	private static function remember_status( $status ) {
		update_option( 'arling_asistent_status', $status );
	}

	/**
	 * Status for this request: cached in a transient for STATUS_CACHE_TTL
	 * seconds (never while the product list is still being read, so "Ready"
	 * shows up on the very next refresh), fetched at most once per request.
	 *
	 * @return array|null Normalised status, or null when it could not be fetched.
	 */
	private function get_current_status() {
		if ( $this->status_fetched ) {
			return $this->status;
		}
		$this->status_fetched = true;

		$tenant_id = $this->tenant_id();
		if ( '' === $tenant_id ) {
			return null;
		}

		$cache_key = 'arling_asistent_status_' . $tenant_id;
		$cached    = get_transient( $cache_key );
		if ( is_array( $cached ) && isset( $cached['status'] ) ) {
			$this->status = $cached;
			return $this->status;
		}

		$result = Arling_Asistent_Api::get_status( $tenant_id );
		if ( empty( $result['ok'] ) ) {
			$this->status_failure = $result;
			return null;
		}

		$status = self::normalise_status( isset( $result['data'] ) ? $result['data'] : array() );
		if ( 'pending' !== $status['status'] ) {
			set_transient( $cache_key, $status, self::STATUS_CACHE_TTL );
		}
		self::remember_status( $status );
		$this->status = $status;
		return $this->status;
	}

	/** WP-Cron callback: refresh the stored status twice a day while connected. */
	public static function cron_status_check() {
		$tenant_id = (string) get_option( 'arling_asistent_tenant_id', '' );
		if ( '' === $tenant_id ) {
			wp_clear_scheduled_hook( ARLING_ASISTENT_CRON_HOOK );
			return;
		}
		$result = Arling_Asistent_Api::get_status( $tenant_id, 10 );
		if ( ! empty( $result['ok'] ) ) {
			self::remember_status( self::normalise_status( isset( $result['data'] ) ? $result['data'] : array() ) );
		}
	}

	/** Make sure the twice-daily status check is scheduled while connected (also covers updates from 0.2.x). */
	public function ensure_status_cron() {
		if ( '' !== $this->tenant_id() && ! wp_next_scheduled( ARLING_ASISTENT_CRON_HOOK ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'twicedaily', ARLING_ASISTENT_CRON_HOOK );
		}
	}

	// -------------------------------------------------------------------
	// First run: activation redirect, Plugins/Dashboard notices
	// -------------------------------------------------------------------

	/**
	 * Right after a single-plugin activation, open the setup screen once.
	 * Skipped for bulk activation, network admin, AJAX, users who cannot
	 * manage WooCommerce, and stores that are already connected.
	 */
	public function maybe_activation_redirect() {
		if ( ! get_transient( 'arling_asistent_activation_redirect' ) ) {
			return;
		}
		delete_transient( 'arling_asistent_activation_redirect' );

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only check of the core bulk-activation flag, no action is taken on it.
		$bulk = isset( $_GET['activate-multi'] );
		if ( $bulk || wp_doing_ajax() || is_network_admin() || ! current_user_can( 'manage_woocommerce' ) || '' !== $this->tenant_id() ) {
			return;
		}
		wp_safe_redirect( $this->settings_url() );
		exit;
	}

	private function dismissed_notices() {
		$dismissed = get_user_meta( get_current_user_id(), self::DISMISSED_META, true );
		return is_array( $dismissed ) ? $dismissed : array();
	}

	/**
	 * Notices on the Dashboard and Plugins screens only, each hideable for
	 * good with its own link: one to finish setup, one when setup failed, and
	 * one when the monthly conversations are 80 % or 100 % used. They read
	 * the stored status and never make a remote call.
	 */
	public function render_admin_notices() {
		if ( ! current_user_can( 'manage_woocommerce' ) || ! function_exists( 'get_current_screen' ) ) {
			return;
		}
		$screen = get_current_screen();
		if ( ! $screen || ! in_array( $screen->id, array( 'dashboard', 'plugins' ), true ) ) {
			return;
		}
		$dismissed = $this->dismissed_notices();

		if ( '' === $this->tenant_id() ) {
			if ( empty( $dismissed['setup'] ) ) {
				$this->print_notice(
					'info',
					__( 'ARLing Shopping Assistant is installed but not switched on yet. It takes about a minute, inside WordPress, with no account on another website.', 'arling-asistent' ),
					array( array( $this->settings_url(), __( 'Switch on the assistant', 'arling-asistent' ), true, false ) ),
					'setup'
				);
			}
			return;
		}

		$status = get_option( 'arling_asistent_status' );
		if ( ! is_array( $status ) || empty( $status['status'] ) ) {
			return;
		}

		if ( 'error' === $status['status'] ) {
			$key = 'error-' . ( ! empty( $status['last_error'] ) ? $status['last_error'] : 'unknown' );
			if ( empty( $dismissed[ $key ] ) ) {
				$this->print_notice(
					'warning',
					__( 'ARLing Shopping Assistant could not read your products, so shoppers do not see it. The settings page says why and how to fix it.', 'arling-asistent' ),
					array( array( $this->settings_url(), __( 'See what to fix', 'arling-asistent' ), true, false ) ),
					$key
				);
			}
			return;
		}

		if ( 'ready' === $status['status'] && (int) $status['usage_percent'] >= self::USAGE_WARNING_PERCENT ) {
			$full = (int) $status['usage_percent'] >= 100;
			$key  = 'usage-' . sanitize_key( (string) $status['period_end'] ) . '-' . ( $full ? '100' : '80' );
			if ( ! empty( $dismissed[ $key ] ) ) {
				return;
			}
			$reset = $this->format_date( $status['period_end'] );
			if ( $full ) {
				$message = sprintf(
					/* translators: 1: conversations used, 2: monthly limit, 3: date the count starts again. */
					__( 'Your shopping assistant has used all %1$d of %2$d conversations this month. New shoppers are told it is resting until %3$s, unless you move to a larger plan.', 'arling-asistent' ),
					(int) $status['used'],
					(int) $status['monthly_quota'],
					$reset
				);
			} else {
				$message = sprintf(
					/* translators: 1: conversations used, 2: monthly limit, 3: date the count starts again. */
					__( 'Your shopping assistant has used %1$d of %2$d conversations this month. When it reaches the limit, new shoppers are told it is resting until %3$s.', 'arling-asistent' ),
					(int) $status['used'],
					(int) $status['monthly_quota'],
					$reset
				);
			}
			$this->print_notice(
				$full ? 'error' : 'warning',
				$message,
				array( array( $this->settings_url() . '#arling-asistent-plan', __( 'See plans', 'arling-asistent' ), true, false ) ),
				$key
			);
		}
	}

	/**
	 * @param string $type    notice-{type}: info, warning, error.
	 * @param string $message Plain text.
	 * @param array  $actions List of array( url, label, primary, external ).
	 * @param string $key     Key recorded when the user hides this notice.
	 */
	private function print_notice( $type, $message, $actions, $key ) {
		$hide_url = wp_nonce_url(
			add_query_arg(
				array(
					'action' => 'arling_asistent_dismiss',
					'notice' => $key,
				),
				admin_url( 'admin-post.php' )
			),
			'arling_asistent_dismiss'
		);
		echo '<div class="notice notice-' . esc_attr( $type ) . '"><p><strong>' . esc_html__( 'ARLing Shopping Assistant', 'arling-asistent' ) . ':</strong> ' . esc_html( $message ) . '</p><p>';
		foreach ( $actions as $action ) {
			echo '<a class="button' . ( $action[2] ? ' button-primary' : '' ) . '" href="' . esc_url( $action[0] ) . '"' . ( $action[3] ? ' target="_blank" rel="noopener noreferrer"' : '' ) . '>' . esc_html( $action[1] ) . '</a> ';
		}
		echo '<a href="' . esc_url( $hide_url ) . '">' . esc_html__( 'Hide this notice', 'arling-asistent' ) . '</a></p></div>';
	}

	public function handle_dismiss() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'arling-asistent' ), 403 );
		}
		check_admin_referer( 'arling_asistent_dismiss' );

		$key = isset( $_GET['notice'] ) ? sanitize_key( wp_unslash( $_GET['notice'] ) ) : '';
		if ( '' !== $key ) {
			$dismissed         = $this->dismissed_notices();
			$dismissed[ $key ] = time();
			update_user_meta( get_current_user_id(), self::DISMISSED_META, $dismissed );
		}

		$back = wp_get_referer();
		wp_safe_redirect( $back ? $back : admin_url() );
		exit;
	}

	// -------------------------------------------------------------------
	// Scripts on the settings page
	// -------------------------------------------------------------------

	/**
	 * On the settings page only: a small script for the "Try it now"
	 * buttons and, once the assistant is ready, the widget itself, so the
	 * merchant can talk to their own assistant without leaving this page.
	 * The widget script is the same one the storefront loads, from the same
	 * service, and only ever after the store has been connected.
	 *
	 * @param string $hook_suffix Current admin page.
	 */
	public function enqueue_admin_assets( $hook_suffix ) {
		if ( '' === $this->page_hook || $hook_suffix !== $this->page_hook ) {
			return;
		}
		wp_enqueue_script( 'arling-asistent-admin', ARLING_ASISTENT_URL . 'js/admin.js', array(), ARLING_ASISTENT_VERSION, true );

		$status = $this->get_current_status();
		if ( is_array( $status ) && 'ready' === $status['status'] ) {
			Arling_Asistent_Frontend::instance()->enqueue_widget_script();
		}
	}

	// -------------------------------------------------------------------
	// Action handlers (admin-post.php)
	// -------------------------------------------------------------------

	public function handle_connect() {
		$this->require_capability_and_nonce( 'arling_asistent_connect', 'arling_asistent_connect_nonce' );

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above; the sniff cannot see across that method call.
		$consent = isset( $_POST['arling_asistent_consent'] ) && '1' === sanitize_text_field( wp_unslash( $_POST['arling_asistent_consent'] ) );
		if ( ! $consent ) {
			$this->redirect_with_notice( 'error', __( 'Please tick the consent checkbox to connect your store.', 'arling-asistent' ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above.
		$email = isset( $_POST['arling_asistent_email'] ) ? sanitize_email( wp_unslash( $_POST['arling_asistent_email'] ) ) : '';
		if ( empty( $email ) || ! is_email( $email ) ) {
			$this->redirect_with_notice( 'error', __( 'Please enter a valid contact e-mail address.', 'arling-asistent' ) );
		}

		$problem = $this->site_reachability_problem();
		if ( '' !== $problem ) {
			$this->redirect_with_notice( 'error', $problem );
		}
		if ( 0 === $this->published_product_count() ) {
			$this->redirect_with_notice( 'error', __( 'Your shop has no published products yet, so the assistant would have nothing to answer from. Publish at least one product, then connect.', 'arling-asistent' ) );
		}

		$feed_url = $this->default_feed_url();
		$domain   = $this->default_domain();

		$result = Arling_Asistent_Api::create_tenant( $feed_url, $domain, $email );
		if ( empty( $result['ok'] ) ) {
			$this->redirect_with_notice( 'error', $this->connect_error_message( $result ) );
		}

		$data = isset( $result['data'] ) && is_array( $result['data'] ) ? $result['data'] : array();
		if ( empty( $data['id'] ) ) {
			$this->redirect_with_notice( 'error', __( 'ARLing Shopping Assistant did not return a tenant id. Please try again.', 'arling-asistent' ) );
		}

		$tenant_id = sanitize_text_field( $data['id'] );
		update_option( 'arling_asistent_tenant_id', $tenant_id );
		update_option( 'arling_asistent_domain', $domain );
		update_option( 'arling_asistent_email', $email );
		update_option( 'arling_asistent_connected_at', time() );
		delete_transient( 'arling_asistent_status_' . $tenant_id );
		self::remember_status( self::normalise_status( $data ) );

		// Sensible defaults on first connect; a merchant can change these
		// right away on the same page.
		if ( false === get_option( 'arling_asistent_lang', false ) ) {
			update_option( 'arling_asistent_lang', 'auto' );
		}
		if ( false === get_option( 'arling_asistent_color', false ) ) {
			update_option( 'arling_asistent_color', 'auto' );
		}
		if ( false === get_option( 'arling_asistent_position', false ) ) {
			update_option( 'arling_asistent_position', 'bottom-right' );
		}
		// All pages by default since 0.3.0: most merchants check the home
		// page first, and a bubble limited to WooCommerce pages looked like
		// a plugin that does nothing.
		if ( false === get_option( 'arling_asistent_display_scope', false ) ) {
			update_option( 'arling_asistent_display_scope', 'all' );
		}
		// Gift finder is off by default: turning it on changes what shoppers
		// see on the storefront, so it has to be an explicit merchant choice.
		if ( false === get_option( 'arling_asistent_gift', false ) ) {
			update_option( 'arling_asistent_gift', '0' );
		}

		$this->ensure_status_cron();

		if ( ! empty( $data['existing'] ) && isset( $data['status'] ) && 'ready' === $data['status'] ) {
			$this->redirect_with_notice( 'success', __( 'Reconnected to the assistant this shop already had.', 'arling-asistent' ) );
		}
		$this->redirect_with_notice( 'success', __( 'Connected. Your products are being read now; this usually takes under a minute.', 'arling-asistent' ) );
	}

	/**
	 * "Try again" after a failed setup: sends the same product list URL,
	 * domain and contact e-mail as the original connection (the service
	 * restarts reading the products only when the e-mail matches the one
	 * this store connected with).
	 */
	public function handle_retry() {
		$this->require_capability_and_nonce( 'arling_asistent_retry', 'arling_asistent_retry_nonce' );

		$tenant_id = $this->tenant_id();
		$email     = (string) get_option( 'arling_asistent_email', '' );
		if ( '' === $tenant_id || '' === $email ) {
			$this->redirect_with_notice( 'error', __( 'This store is not connected yet.', 'arling-asistent' ) );
		}

		$result = Arling_Asistent_Api::create_tenant( $this->default_feed_url(), $this->default_domain(), $email );
		delete_transient( 'arling_asistent_status_' . $tenant_id );
		if ( empty( $result['ok'] ) ) {
			$this->redirect_with_notice( 'error', $this->connect_error_message( $result ) );
		}
		if ( isset( $result['data'] ) && is_array( $result['data'] ) ) {
			self::remember_status( self::normalise_status( $result['data'] ) );
		}
		$this->redirect_with_notice( 'success', __( 'Trying again. Your products are being read now.', 'arling-asistent' ) );
	}

	public function handle_disconnect() {
		$this->require_capability_and_nonce( 'arling_asistent_disconnect', 'arling_asistent_disconnect_nonce' );

		$tenant_id = $this->tenant_id();
		if ( $tenant_id ) {
			delete_transient( 'arling_asistent_status_' . $tenant_id );
		}

		delete_option( 'arling_asistent_tenant_id' );
		delete_option( 'arling_asistent_domain' );
		delete_option( 'arling_asistent_email' );
		delete_option( 'arling_asistent_connected_at' );
		delete_option( 'arling_asistent_status' );
		wp_clear_scheduled_hook( ARLING_ASISTENT_CRON_HOOK );

		$this->redirect_with_notice( 'success', __( 'Disconnected. The widget will no longer appear on your site.', 'arling-asistent' ) );
	}

	public function handle_save_settings() {
		$this->require_capability_and_nonce( 'arling_asistent_save_settings', 'arling_asistent_save_settings_nonce' );

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above; the sniff cannot see across that method call.
		$lang = isset( $_POST['arling_asistent_lang'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_lang'] ) ) : 'auto';
		if ( ! in_array( $lang, array( 'auto', 'sk', 'cs', 'en', 'de' ), true ) ) {
			$lang = 'auto';
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above.
		$color = isset( $_POST['arling_asistent_color'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_color'] ) ) : 'auto';
		if ( ! in_array( $color, array( 'auto', 'light', 'dark' ), true ) ) {
			$color = 'auto';
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above.
		$position = isset( $_POST['arling_asistent_position'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_position'] ) ) : 'bottom-right';
		if ( ! in_array( $position, array( 'bottom-right', 'bottom-left' ), true ) ) {
			$position = 'bottom-right';
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above.
		$scope = isset( $_POST['arling_asistent_display_scope'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_display_scope'] ) ) : 'all';
		if ( ! in_array( $scope, array( 'disabled', 'shop', 'all' ), true ) ) {
			$scope = 'all';
		}

		// An unticked checkbox is not posted at all, so a missing key means
		// "off" here rather than "keep the previous value".
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce and capability already verified by require_capability_and_nonce() above.
		$gift = ( isset( $_POST['arling_asistent_gift'] ) && '1' === sanitize_text_field( wp_unslash( $_POST['arling_asistent_gift'] ) ) ) ? '1' : '0';

		update_option( 'arling_asistent_lang', $lang );
		update_option( 'arling_asistent_color', $color );
		update_option( 'arling_asistent_position', $position );
		update_option( 'arling_asistent_display_scope', $scope );
		update_option( 'arling_asistent_gift', $gift );

		$this->redirect_with_notice( 'success', __( 'Settings saved.', 'arling-asistent' ) );
	}

	public function handle_refresh_status() {
		$this->require_capability_and_nonce( 'arling_asistent_refresh_status', 'arling_asistent_refresh_status_nonce' );

		$tenant_id = $this->tenant_id();
		if ( $tenant_id ) {
			delete_transient( 'arling_asistent_status_' . $tenant_id );
			// get_current_status() repopulates the transient on render.
		}

		wp_safe_redirect( $this->settings_url() );
		exit;
	}

	// -------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------

	public function render_page() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'arling-asistent' ), 403 );
		}

		$tenant_id = $this->tenant_id();

		echo '<div class="wrap arling-asistent-settings">';
		echo '<h1>' . esc_html__( 'ARLing Shopping Assistant', 'arling-asistent' ) . '</h1>';

		$this->render_notice();

		if ( '' === $tenant_id ) {
			$this->render_connect_section();
		} else {
			$status = $this->get_current_status();
			if ( null === $status ) {
				$this->render_unreachable_section();
			} elseif ( 'pending' === $status['status'] ) {
				$this->render_pending_section();
			} elseif ( 'error' === $status['status'] ) {
				$this->render_error_section( $status );
			} else {
				$this->render_ready_section( $status );
			}
			// Plans and upgrade buttons only once the assistant works: asking
			// for money while the setup is still running or has failed would
			// be selling something the merchant has not seen yet.
			if ( is_array( $status ) && 'ready' === $status['status'] ) {
				echo '<hr />';
				$this->render_plan_section( $tenant_id, $status );
			}
			echo '<hr />';
			$this->render_settings_form();
			echo '<hr />';
			$this->render_disconnect_section();
			$this->render_technical_details( $tenant_id );
		}

		$this->render_footer_links();

		echo '</div>';
	}

	private function render_notice() {
		$key    = 'arling_asistent_notice_' . get_current_user_id();
		$notice = get_transient( $key );
		if ( ! $notice ) {
			return;
		}
		delete_transient( $key );

		$type = 'error' === $notice['type'] ? 'notice-error' : 'notice-success';
		echo '<div class="notice ' . esc_attr( $type ) . ' is-dismissible"><p>' . esc_html( $notice['message'] ) . '</p></div>';
	}

	private function refresh_url() {
		return wp_nonce_url(
			add_query_arg( array( 'action' => 'arling_asistent_refresh_status' ), admin_url( 'admin-post.php' ) ),
			'arling_asistent_refresh_status',
			'arling_asistent_refresh_status_nonce'
		);
	}

	/**
	 * Date for people ("October 1, 2026" in the site's own date format),
	 * from an ISO date or date-time. Empty string when it cannot be read.
	 *
	 * @param string $iso Date string from the status API.
	 * @return string
	 */
	private function format_date( $iso, $with_time = false ) {
		$timestamp = $iso ? strtotime( (string) $iso ) : false;
		if ( ! $timestamp ) {
			return '';
		}
		$format = get_option( 'date_format' );
		if ( $with_time ) {
			$format .= ' ' . get_option( 'time_format' );
		}
		return (string) wp_date( $format, $timestamp );
	}

	private function render_connect_section() {
		$feed_url = $this->default_feed_url();
		$domain   = $this->default_domain();
		$email    = get_option( 'admin_email' );
		$problem  = $this->site_reachability_problem();
		$products = $this->published_product_count();
		$blocked  = ( '' !== $problem ) || ( 0 === $products );
		?>
		<div class="card" style="max-width:760px;padding:1.5em;">
			<h2><?php esc_html_e( 'Switch on your AI shopping assistant', 'arling-asistent' ); ?></h2>
			<p>
				<?php esc_html_e( 'The assistant reads your public product list and answers shoppers\' questions in a chat bubble on your shop, with links to the matching products. Everything happens here in WordPress: no account on another website, no API key, no credit card.', 'arling-asistent' ); ?>
			</p>
			<ul style="list-style:disc;margin-left:1.2em;">
				<li><?php esc_html_e( 'Setup takes about a minute for a few hundred products. As soon as it is ready, you can try the assistant right on this page.', 'arling-asistent' ); ?></li>
				<li><?php
					printf(
						/* translators: %d: number of free conversations per month. */
						esc_html__( 'Free for %d conversations a month. A conversation is one shopper\'s chat, however many questions it has. Paid plans only if you need more: 19 EUR a month for 1,000 or 39 EUR a month for 3,000.', 'arling-asistent' ),
						(int) ARLING_ASISTENT_FREE_CONVERSATIONS
					);
				?></li>
			</ul>

			<?php if ( '' !== $problem ) : ?>
				<div class="notice notice-warning inline"><p><?php echo esc_html( $problem ); ?></p></div>
			<?php elseif ( 0 === $products ) : ?>
				<div class="notice notice-warning inline"><p><?php esc_html_e( 'Your shop has no published products yet, so the assistant would have nothing to answer from. Publish at least one product, then come back to this page.', 'arling-asistent' ); ?></p></div>
			<?php endif; ?>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="arling_asistent_connect" />
				<?php wp_nonce_field( 'arling_asistent_connect', 'arling_asistent_connect_nonce' ); ?>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="arling_asistent_email"><?php esc_html_e( 'Contact e-mail', 'arling-asistent' ); ?></label></th>
						<td>
							<input type="email" required id="arling_asistent_email" name="arling_asistent_email" class="regular-text" value="<?php echo esc_attr( $email ); ?>" />
							<p class="description"><?php esc_html_e( 'Confirms that later changes to this connection come from you, and lets ARLing reach you about your assistant (for example a setup problem). No newsletters, never shared.', 'arling-asistent' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'What will be sent', 'arling-asistent' ); ?></th>
						<td>
							<ul style="list-style:disc;margin-left:1.2em;margin-top:0;">
								<li><?php
									printf(
										/* translators: %s: the store's public product feed URL. */
										esc_html__( 'Your public product list URL: %s', 'arling-asistent' ),
										'<code>' . esc_html( $feed_url ) . '</code>'
									);
								?></li>
								<li><?php
									printf(
										/* translators: %s: the site domain. */
										esc_html__( 'Your site domain: %s', 'arling-asistent' ),
										'<code>' . esc_html( $domain ) . '</code>'
									);
								?></li>
								<li><?php esc_html_e( 'The contact e-mail address entered above.', 'arling-asistent' ); ?></li>
							</ul>
							<p class="description">
								<?php esc_html_e( 'Nothing else is sent. No customer data, no order data, no analytics. Chat conversations are never stored, only daily aggregate counters.', 'arling-asistent' ); ?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Consent', 'arling-asistent' ); ?></th>
						<td>
							<label>
								<input type="checkbox" required name="arling_asistent_consent" value="1" />
								<?php
								printf(
									/* translators: 1: opening link tag to the terms page, 2: opening link tag to the DPA, 3: closing link tag. */
									esc_html__( 'I agree to send the product list URL, site domain and e-mail address above to ARLing s. r. o. (Bratislava, Slovakia) to set up my assistant, and I have read the %1$sTerms%3$s and %2$sData Processing Agreement%3$s.', 'arling-asistent' ),
									'<a href="' . esc_url( 'https://arling.sk/podmienky/' ) . '" target="_blank" rel="noopener noreferrer">',
									'<a href="' . esc_url( 'https://arling.sk/asistent/#gdpr' ) . '" target="_blank" rel="noopener noreferrer">',
									'</a>'
								);
								?>
							</label>
						</td>
					</tr>
				</table>

				<?php
				submit_button(
					__( 'Connect and build my assistant', 'arling-asistent' ),
					'primary',
					'submit',
					true,
					$blocked ? array( 'disabled' => 'disabled' ) : null
				);
				?>
				<p class="description"><?php esc_html_e( 'You can disconnect at any time on this page. Deleting the plugin removes all of its settings from this site.', 'arling-asistent' ); ?></p>
			</form>
		</div>
		<?php
	}

	private function render_unreachable_section() {
		$failure = is_array( $this->status_failure ) ? $this->status_failure : array();
		echo '<h2>' . esc_html__( 'Status', 'arling-asistent' ) . '</h2>';
		if ( isset( $failure['status'] ) && 404 === (int) $failure['status'] ) {
			echo '<p>' . esc_html__( 'Our service no longer knows this connection. Disconnect below, then connect again; it takes about a minute.', 'arling-asistent' ) . '</p>';
		} else {
			echo '<p>' . esc_html__( 'Could not reach ARLing Shopping Assistant right now. Your connection is saved; please try refreshing in a moment.', 'arling-asistent' ) . '</p>';
		}
		echo '<p><a class="button" href="' . esc_url( $this->refresh_url() ) . '">' . esc_html__( 'Refresh status', 'arling-asistent' ) . '</a></p>';
	}

	private function render_pending_section() {
		$products = $this->published_product_count();
		echo '<h2>' . esc_html__( 'Reading your products', 'arling-asistent' ) . '</h2>';
		echo '<p>' . esc_html(
			sprintf(
				/* translators: %d: number of published products on this site. */
				_n(
					'Your assistant is being built from your %d published product. This usually takes under a minute.',
					'Your assistant is being built from your %d published products. This usually takes under a minute.',
					$products,
					'arling-asistent'
				),
				$products
			)
		) . '</p>';
		echo '<p class="description">' . esc_html(
			sprintf(
				/* translators: %d: seconds between automatic refreshes. */
				__( 'This page checks again every %d seconds. You can leave it; the assistant goes live on your shop by itself.', 'arling-asistent' ),
				self::PENDING_REFRESH_SECONDS
			)
		) . '</p>';
		// Simple no-JS auto-poll while ingestion is running, limited to
		// this one settings screen only (never on the public site).
		echo '<meta http-equiv="refresh" content="' . esc_attr( (string) self::PENDING_REFRESH_SECONDS ) . ';url=' . esc_url( $this->settings_url() ) . '" />';
	}

	/**
	 * What went wrong while reading the products, in words the merchant
	 * can act on. Codes come from the service (worker/src/onboarding.js,
	 * INGEST_ERRORS and classifyFeedError).
	 *
	 * @param string $code last_error from the status API.
	 * @return string Plain text.
	 */
	private function error_explanation( $code ) {
		if ( preg_match( '/^feed_http_(\d{3})$/', (string) $code, $m ) ) {
			$http = (int) $m[1];
			if ( 401 === $http || 403 === $http ) {
				return sprintf(
					/* translators: %d: HTTP status code. */
					__( 'Your site refused our request for the product list (HTTP %d). A security plugin, a firewall (for example Cloudflare bot protection) or password protection is blocking the public WooCommerce Store API. Allow requests from the user agent ARLingAsistentBot to the address below, then click Try again.', 'arling-asistent' ),
					$http
				);
			}
			if ( 404 === $http ) {
				return __( 'Your site answered "not found" (HTTP 404) for the product list address below. A plugin has probably switched off the WordPress REST API or the WooCommerce Store API. Allow public access to /wc/store/v1/products, then click Try again.', 'arling-asistent' );
			}
			if ( 429 === $http ) {
				return __( 'Your site or its firewall limited our requests (HTTP 429). Wait a few minutes, then click Try again.', 'arling-asistent' );
			}
			if ( $http >= 500 ) {
				return sprintf(
					/* translators: %d: HTTP status code. */
					__( 'Your site returned a server error (HTTP %d) when we asked for the product list. Check that the address below opens, then click Try again.', 'arling-asistent' ),
					$http
				);
			}
			return sprintf(
				/* translators: %d: HTTP status code. */
				__( 'Your site answered HTTP %d when we asked for the product list. Check that the address below opens in a private browser window, then click Try again.', 'arling-asistent' ),
				$http
			);
		}

		switch ( $code ) {
			case 'no_products':
				return __( 'We found no products in your shop\'s public product list. Publish at least one product that is visible in the catalogue, then click Try again.', 'arling-asistent' );
			case 'feed_not_readable':
				return __( 'Your site answered with a page that is not a product list. Usually a maintenance or coming soon page, a login wall or a firewall check page is shown instead of the WooCommerce Store API. Open the address below in a private browser window: it should show text that starts with [{. Then click Try again.', 'arling-asistent' );
			case 'feed_unreachable':
				return __( 'Our service could not connect to your site. Check that the site is online and reachable from the internet, then click Try again.', 'arling-asistent' );
			case 'feed_url_private_host':
			case 'feed_url_scheme':
			case 'feed_url_invalid':
			case 'feed_too_many_redirects':
				return __( 'The product list address below redirects to a local or private address, or through too many other addresses, which our service does not follow for security reasons. Make sure it opens directly on your public domain, then click Try again.', 'arling-asistent' );
			case 'ai_budget_exhausted':
				return __( 'Our service reached its processing limit for today, so your products have not been read yet. This is on our side, not yours. They are read again automatically at about 03:00 UTC, or click Try again tomorrow.', 'arling-asistent' );
			case '':
				// No reason recorded (a setup that failed before the service
				// started recording reasons). Do not guess whose fault it was.
				return __( 'We could not read your product list. Open the address below in a private browser window and check that it shows your products as text that starts with [{, then click Try again. If it keeps failing, write to andrej@arling.sk with your site address.', 'arling-asistent' );
			default:
				return __( 'Something went wrong on our side while reading your products. Click Try again; if it keeps failing, write to andrej@arling.sk with your site address.', 'arling-asistent' );
		}
	}

	/**
	 * @param array $status Normalised status.
	 */
	private function render_error_section( $status ) {
		$feed_url = $this->default_feed_url();
		?>
		<div class="notice notice-error inline" style="max-width:760px;">
			<p><strong><?php esc_html_e( 'Your assistant is not live yet: we could not read your products.', 'arling-asistent' ); ?></strong></p>
			<p><?php echo esc_html( $this->error_explanation( $status['last_error'] ) ); ?></p>
			<p>
				<?php esc_html_e( 'Product list address:', 'arling-asistent' ); ?>
				<a href="<?php echo esc_url( $feed_url ); ?>" target="_blank" rel="noopener noreferrer"><code><?php echo esc_html( $feed_url ); ?></code></a>
			</p>
		</div>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-top:1em;">
			<input type="hidden" name="action" value="arling_asistent_retry" />
			<?php wp_nonce_field( 'arling_asistent_retry', 'arling_asistent_retry_nonce' ); ?>
			<?php submit_button( __( 'Try again', 'arling-asistent' ), 'primary', 'submit', false ); ?>
		</form>
		<p class="description" style="max-width:760px;">
			<?php esc_html_e( 'Shoppers do not see the chat bubble while the assistant is not live. If this shop was connected before with a different contact e-mail, Try again only works with that e-mail: disconnect below, then connect again using it.', 'arling-asistent' ); ?>
		</p>
		<?php
	}

	/**
	 * Up to three example questions built from this shop's own catalogue
	 * (read locally, nothing is sent), so the first test of the assistant is
	 * a question it can actually answer.
	 *
	 * @return string[]
	 */
	private function example_questions() {
		$questions = array();

		$terms = get_terms(
			array(
				'taxonomy'   => 'product_cat',
				'orderby'    => 'count',
				'order'      => 'DESC',
				'number'     => 3,
				'hide_empty' => true,
			)
		);
		if ( is_array( $terms ) ) {
			$default_cat = (int) get_option( 'default_product_cat', 0 );
			foreach ( $terms as $term ) {
				if ( (int) $term->term_id === $default_cat || 'uncategorized' === $term->slug ) {
					continue;
				}
				/* translators: %s: a product category name from this shop. */
				$questions[] = sprintf( __( 'What do you have in %s?', 'arling-asistent' ), $term->name );
				break;
			}
		}

		if ( function_exists( 'wc_get_products' ) ) {
			$products = wc_get_products(
				array(
					'status'  => 'publish',
					'limit'   => 1,
					'orderby' => 'date',
					'order'   => 'DESC',
				)
			);
			if ( ! empty( $products ) && is_object( $products[0] ) ) {
				/* translators: %s: a product name from this shop. */
				$questions[] = sprintf( __( 'Tell me more about %s.', 'arling-asistent' ), wp_strip_all_tags( $products[0]->get_name() ) );
			}
		}

		$questions[] = __( 'What would you recommend as a gift?', 'arling-asistent' );

		return array_slice( array_values( array_unique( $questions ) ), 0, 3 );
	}

	/**
	 * @param array $status Normalised status.
	 */
	private function render_ready_section( $status ) {
		$scope    = get_option( 'arling_asistent_display_scope', 'all' );
		$shop_url = function_exists( 'wc_get_page_permalink' ) ? wc_get_page_permalink( 'shop' ) : home_url( '/' );
		$count    = isset( $status['product_count'] ) && null !== $status['product_count'] ? (int) $status['product_count'] : $this->published_product_count();

		$where = array(
			'all'      => __( 'on every page of your site', 'arling-asistent' ),
			'shop'     => __( 'on your WooCommerce pages (shop, product, cart, checkout, account)', 'arling-asistent' ),
			'disabled' => '',
		);
		?>
		<div class="notice notice-success inline" style="max-width:760px;">
			<p>
				<strong><?php esc_html_e( 'Your assistant is ready.', 'arling-asistent' ); ?></strong>
				<?php
				if ( 'disabled' === $scope ) {
					esc_html_e( 'It is switched off on your shop right now (Show widget on: Nowhere, in the settings below).', 'arling-asistent' );
				} else {
					echo esc_html(
						sprintf(
							/* translators: 1: number of products read, 2: where on the site the chat bubble is shown. */
							_n(
								'It answers from the %1$d product it read, and shoppers see it %2$s.',
								'It answers from the %1$d products it read, and shoppers see it %2$s.',
								$count,
								'arling-asistent'
							),
							$count,
							isset( $where[ $scope ] ) ? $where[ $scope ] : $where['all']
						)
					);
				}
				?>
			</p>
		</div>

		<h2><?php esc_html_e( 'Try it now', 'arling-asistent' ); ?></h2>
		<p><?php esc_html_e( 'The chat bubble in the bottom corner of this page is your assistant, answering from your own products. Ask what a customer would ask, or click an example:', 'arling-asistent' ); ?></p>
		<p>
			<?php foreach ( $this->example_questions() as $question ) : ?>
				<button type="button" class="button" data-arling-ask="<?php echo esc_attr( $question ); ?>"><?php echo esc_html( $question ); ?></button>
			<?php endforeach; ?>
			<button type="button" class="button button-primary" data-arling-open="1"><?php esc_html_e( 'Open the chat', 'arling-asistent' ); ?></button>
		</p>
		<p id="arling-asistent-preview-note" class="description" hidden>
			<?php esc_html_e( 'The chat has not loaded on this page. An ad blocker or a security plugin may be blocking arling-asistent.arling.workers.dev; allow it, then reload this page.', 'arling-asistent' ); ?>
		</p>
		<p>
			<a class="button" href="<?php echo esc_url( $shop_url ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Open your shop in a new tab', 'arling-asistent' ); ?></a>
		</p>
		<p class="description" style="max-width:760px;">
			<?php
			$last = $this->format_date( $status['last_ingest'], true );
			if ( '' !== $last ) {
				printf(
					/* translators: %s: date and time of the last successful product read. */
					esc_html__( 'Test chats here count toward your monthly conversations, one per browser tab per day. Products are read again automatically once a day (last read: %s).', 'arling-asistent' ),
					esc_html( $last )
				);
			} else {
				esc_html_e( 'Test chats here count toward your monthly conversations, one per browser tab per day. Products are read again automatically once a day.', 'arling-asistent' );
			}
			?>
		</p>
		<?php
	}

	/**
	 * Builds an "Upgrade" URL from a Stripe Payment Link base URL by
	 * appending `client_reference_id=$tenant_id` (or, if the link already
	 * has a query string, `&client_reference_id=...`), so the licence
	 * service's Stripe webhook (see products/licence-service/app.py) can
	 * tell which tenant a successful checkout belongs to. Returns '' (never
	 * a malformed URL) when `$base_link` is empty, i.e. not configured yet.
	 *
	 * @param string $base_link Stripe Payment Link URL, or ''.
	 * @param string $tenant_id This site's connected tenant id.
	 * @return string
	 */
	private function build_upgrade_url( $base_link, $tenant_id ) {
		$base_link = trim( (string) $base_link );
		if ( '' === $base_link || empty( $tenant_id ) ) {
			return '';
		}
		$separator = ( false === strpos( $base_link, '?' ) ) ? '?' : '&';
		return $base_link . $separator . 'client_reference_id=' . rawurlencode( $tenant_id );
	}

	/**
	 * Plan and usage: what is used, what happens at the limit, and one
	 * button per plan that is actually a step up (Starter 19 EUR/month,
	 * Pro 39 EUR/month), each linking to that plan's Stripe Payment Link
	 * with this store's tenant id attached (see build_upgrade_url() above).
	 * The buttons turn primary from USAGE_WARNING_PERCENT on, the moment an
	 * upgrade actually matters. A plan whose link is not configured shows a
	 * disabled "coming soon" button instead of a broken link.
	 *
	 * @param string $tenant_id This site's connected tenant id.
	 * @param array  $status    Normalised status.
	 */
	private function render_plan_section( $tenant_id, $status ) {
		$plan         = in_array( $status['plan'], array( 'free', 'starter', 'pro' ), true ) ? $status['plan'] : 'free';
		$plan_names   = array(
			'free'    => __( 'Free', 'arling-asistent' ),
			'starter' => __( 'Starter', 'arling-asistent' ),
			'pro'     => __( 'Pro', 'arling-asistent' ),
		);
		$quota        = (int) $status['monthly_quota'];
		$used         = (int) $status['used'];
		$percent      = (int) $status['usage_percent'];
		$starter_link = $this->build_upgrade_url( Arling_Asistent_Api::stripe_link_starter(), $tenant_id );
		$pro_link     = $this->build_upgrade_url( Arling_Asistent_Api::stripe_link_pro(), $tenant_id );
		$urgent       = $percent >= self::USAGE_WARNING_PERCENT;
		$reset        = $this->format_date( $status['period_end'] );

		// Only show plans that are actually a step up. A shop on Pro was offered
		// "Upgrade to Starter" and "Upgrade to Pro" at the same time, which
		// reads as a bug and undermines trust in the status table above it.
		$rank         = array(
			'free'    => 0,
			'starter' => 1,
			'pro'     => 2,
		);
		$current_rank = $rank[ $plan ];

		echo '<h2 id="arling-asistent-plan">' . esc_html__( 'Plan and usage', 'arling-asistent' ) . '</h2>';
		echo '<p>';
		printf(
			/* translators: %s: plan name. */
			esc_html__( 'Plan: %s.', 'arling-asistent' ),
			'<strong>' . esc_html( $plan_names[ $plan ] ) . '</strong>'
		);
		echo ' ';
		if ( $quota > 0 ) {
			if ( '' !== $reset ) {
				printf(
					/* translators: 1: conversations used, 2: monthly limit, 3: date the count starts again. */
					esc_html__( '%1$s of %2$s conversations used this month; the count starts again on %3$s.', 'arling-asistent' ),
					'<strong>' . esc_html( number_format_i18n( $used ) ) . '</strong>',
					'<strong>' . esc_html( number_format_i18n( $quota ) ) . '</strong>',
					esc_html( $reset )
				);
			} else {
				printf(
					/* translators: 1: conversations used, 2: monthly limit. */
					esc_html__( '%1$s of %2$s conversations used this month.', 'arling-asistent' ),
					'<strong>' . esc_html( number_format_i18n( $used ) ) . '</strong>',
					'<strong>' . esc_html( number_format_i18n( $quota ) ) . '</strong>'
				);
			}
		}
		echo '</p>';
		if ( $quota > 0 ) {
			echo '<progress max="100" value="' . esc_attr( (string) $percent ) . '" style="width:100%;max-width:420px;height:12px;" aria-label="' . esc_attr__( 'Conversations used this month', 'arling-asistent' ) . '"></progress>';
		}
		echo '<p class="description" style="max-width:760px;">' . esc_html__( 'A conversation is one shopper\'s chat in one browser tab within 24 hours, however many questions it has. When the monthly limit is reached, the chat tells new shoppers the assistant is resting and points them to your contact page, until the count starts again or you move to a larger plan. The free plan never charges anything.', 'arling-asistent' ) . '</p>';

		if ( $current_rank >= $rank['pro'] ) {
			echo '<p class="description">' . esc_html__( 'You are on the highest plan. Need a larger monthly limit? Write to andrej@arling.sk and we will set it up for you.', 'arling-asistent' ) . '</p>';
			$this->render_manage_link();
			return;
		}

		$button_class = $urgent ? 'button button-primary' : 'button';
		echo '<p>';
		if ( $current_rank < $rank['starter'] ) {
			if ( $starter_link ) {
				echo '<a class="' . esc_attr( $button_class ) . '" href="' . esc_url( $starter_link ) . '" target="_blank" rel="noopener noreferrer">' .
					esc_html__( 'Upgrade to Starter (19 EUR/month, up to 1,000 conversations)', 'arling-asistent' ) . '</a> ';
			} else {
				echo '<span class="button disabled" aria-disabled="true">' . esc_html__( 'Starter: coming soon', 'arling-asistent' ) . '</span> ';
			}
		}
		if ( $pro_link ) {
			echo '<a class="' . esc_attr( $button_class ) . '" href="' . esc_url( $pro_link ) . '" target="_blank" rel="noopener noreferrer">' .
				esc_html__( 'Upgrade to Pro (39 EUR/month, up to 3,000 conversations)', 'arling-asistent' ) . '</a>';
		} else {
			echo '<span class="button disabled" aria-disabled="true">' . esc_html__( 'Pro: coming soon', 'arling-asistent' ) . '</span>';
		}
		echo '</p>';
		echo '<p class="description">' . esc_html__( 'Opens Stripe Checkout in a new tab. Your plan updates here automatically within a few minutes of a successful payment. A paid plan renews monthly until you cancel it in the Stripe customer portal.', 'arling-asistent' ) . '</p>';
		if ( $current_rank > $rank['free'] ) {
			$this->render_manage_link();
		}
	}

	private function render_manage_link() {
		echo '<p><a href="' . esc_url( ARLING_ASISTENT_STRIPE_PORTAL ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Manage or cancel your subscription (Stripe customer portal)', 'arling-asistent' ) . '</a></p>';
	}

	private function render_settings_form() {
		$lang     = get_option( 'arling_asistent_lang', 'auto' );
		$color    = get_option( 'arling_asistent_color', 'auto' );
		$position = get_option( 'arling_asistent_position', 'bottom-right' );
		$scope    = get_option( 'arling_asistent_display_scope', 'all' );
		$gift     = get_option( 'arling_asistent_gift', '0' );
		?>
		<h2><?php esc_html_e( 'Widget settings', 'arling-asistent' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="arling_asistent_save_settings" />
			<?php wp_nonce_field( 'arling_asistent_save_settings', 'arling_asistent_save_settings_nonce' ); ?>

			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="arling_asistent_display_scope"><?php esc_html_e( 'Show widget on', 'arling-asistent' ); ?></label></th>
					<td>
						<select id="arling_asistent_display_scope" name="arling_asistent_display_scope">
							<?php
							$options = array(
								'all'      => __( 'All pages', 'arling-asistent' ),
								'shop'     => __( 'WooCommerce pages only (shop, product, cart, checkout, account)', 'arling-asistent' ),
								'disabled' => __( 'Nowhere (temporarily disable the widget)', 'arling-asistent' ),
							);
							foreach ( $options as $value => $text ) {
								echo '<option value="' . esc_attr( $value ) . '" ' . selected( $scope, $value, false ) . '>' . esc_html( $text ) . '</option>';
							}
							?>
						</select>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="arling_asistent_lang"><?php esc_html_e( 'Language', 'arling-asistent' ); ?></label></th>
					<td>
						<select id="arling_asistent_lang" name="arling_asistent_lang">
							<?php
							$options = array(
								'auto' => __( 'Automatic (site language)', 'arling-asistent' ),
								'sk'   => __( 'Slovak', 'arling-asistent' ),
								'cs'   => __( 'Czech', 'arling-asistent' ),
								'en'   => __( 'English', 'arling-asistent' ),
								'de'   => __( 'German', 'arling-asistent' ),
							);
							foreach ( $options as $value => $text ) {
								echo '<option value="' . esc_attr( $value ) . '" ' . selected( $lang, $value, false ) . '>' . esc_html( $text ) . '</option>';
							}
							?>
						</select>
						<p class="description"><?php esc_html_e( 'Slovak, Czech, English and German are built in. On a site in another language, Automatic shows the chat buttons in English and answers each shopper in the language they write in.', 'arling-asistent' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="arling_asistent_color"><?php esc_html_e( 'Accent colour mode', 'arling-asistent' ); ?></label></th>
					<td>
						<select id="arling_asistent_color" name="arling_asistent_color">
							<?php
							$options = array(
								'auto'  => __( 'Automatic (matches visitor device)', 'arling-asistent' ),
								'light' => __( 'Light', 'arling-asistent' ),
								'dark'  => __( 'Dark', 'arling-asistent' ),
							);
							foreach ( $options as $value => $text ) {
								echo '<option value="' . esc_attr( $value ) . '" ' . selected( $color, $value, false ) . '>' . esc_html( $text ) . '</option>';
							}
							?>
						</select>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="arling_asistent_position"><?php esc_html_e( 'Position', 'arling-asistent' ); ?></label></th>
					<td>
						<select id="arling_asistent_position" name="arling_asistent_position">
							<?php
							$options = array(
								'bottom-right' => __( 'Bottom right', 'arling-asistent' ),
								'bottom-left'  => __( 'Bottom left', 'arling-asistent' ),
							);
							foreach ( $options as $value => $text ) {
								echo '<option value="' . esc_attr( $value ) . '" ' . selected( $position, $value, false ) . '>' . esc_html( $text ) . '</option>';
							}
							?>
						</select>
						<p class="description"><?php esc_html_e( 'Which bottom corner of your storefront the chat bubble sits in.', 'arling-asistent' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="arling_asistent_gift"><?php esc_html_e( 'Gift finder', 'arling-asistent' ); ?></label></th>
					<td>
						<input type="checkbox" id="arling_asistent_gift" name="arling_asistent_gift" value="1" <?php checked( '1', $gift ); ?> />
						<p class="description"><?php esc_html_e( 'Adds a Find a gift button to the chat: three questions (for whom, budget, interests) and up to five products from your catalogue.', 'arling-asistent' ); ?></p>
					</td>
				</tr>
			</table>

			<?php submit_button( __( 'Save settings', 'arling-asistent' ) ); ?>
		</form>
		<?php
	}

	private function render_disconnect_section() {
		?>
		<h2><?php esc_html_e( 'Disconnect', 'arling-asistent' ); ?></h2>
		<p><?php esc_html_e( 'Removes the widget from your site immediately. This does not delete your data on ARLing\'s servers; contact andrej@arling.sk or see the Data Processing Agreement to request deletion.', 'arling-asistent' ); ?></p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect ARLing Shopping Assistant from this store?', 'arling-asistent' ) ); ?>');">
			<input type="hidden" name="action" value="arling_asistent_disconnect" />
			<?php wp_nonce_field( 'arling_asistent_disconnect', 'arling_asistent_disconnect_nonce' ); ?>
			<?php submit_button( __( 'Disconnect', 'arling-asistent' ), 'delete' ); ?>
		</form>
		<?php
	}

	/**
	 * @param string $tenant_id This site's connected tenant id.
	 */
	private function render_technical_details( $tenant_id ) {
		?>
		<details style="margin-top:1em;max-width:760px;">
			<summary><?php esc_html_e( 'Technical details', 'arling-asistent' ); ?></summary>
			<p><?php esc_html_e( 'Tenant ID', 'arling-asistent' ); ?>: <code><?php echo esc_html( $tenant_id ); ?></code></p>
			<p><?php esc_html_e( 'Product list URL', 'arling-asistent' ); ?>: <code><?php echo esc_html( $this->default_feed_url() ); ?></code></p>
			<p><a class="button" href="<?php echo esc_url( $this->refresh_url() ); ?>"><?php esc_html_e( 'Refresh status', 'arling-asistent' ); ?></a></p>
		</details>
		<?php
	}

	private function render_footer_links() {
		?>
		<p class="description">
			<a href="<?php echo esc_url( 'https://arling.sk/asistent/#gdpr' ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Data Processing Agreement', 'arling-asistent' ); ?></a>
			&nbsp;&middot;&nbsp;
			<a href="<?php echo esc_url( 'https://arling.sk/podmienky/' ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Terms of Service', 'arling-asistent' ); ?></a>
			&nbsp;&middot;&nbsp;
			<a href="<?php echo esc_url( 'https://arling.sk/gdpr/' ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Privacy Policy', 'arling-asistent' ); ?></a>
		</p>
		<?php
	}
}
