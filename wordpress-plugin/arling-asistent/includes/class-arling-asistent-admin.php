<?php
/**
 * Settings page under WooCommerce > ARLing Asistent: connect/disconnect the
 * store, choose language/colour/position/display scope, and show the
 * tenant's ingestion status. Every state-changing action here goes through
 * admin-post.php with a nonce and a current_user_can( 'manage_woocommerce' )
 * capability check; nothing is ever wired to a bare GET request.
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Arling_Asistent_Admin {

	/** @var Arling_Asistent_Admin|null */
	private static $instance = null;

	/** How long a fetched tenant status is cached before the settings page fetches it again on its own (seconds). */
	const STATUS_CACHE_TTL = 30;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_menu', array( $this, 'register_menu' ) );

		add_action( 'admin_post_arling_asistent_connect', array( $this, 'handle_connect' ) );
		add_action( 'admin_post_arling_asistent_disconnect', array( $this, 'handle_disconnect' ) );
		add_action( 'admin_post_arling_asistent_save_settings', array( $this, 'handle_save_settings' ) );
		add_action( 'admin_post_arling_asistent_refresh_status', array( $this, 'handle_refresh_status' ) );
	}

	public function register_menu() {
		add_submenu_page(
			'woocommerce',
			__( 'ARLing Asistent', 'arling-asistent' ),
			__( 'ARLing Asistent', 'arling-asistent' ),
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

	private function default_feed_url() {
		return trailingslashit( home_url() ) . 'wp-json/wc/store/v1/products?per_page=100';
	}

	private function default_domain() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		return $host ? $host : '';
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

	// -------------------------------------------------------------------
	// Action handlers (admin-post.php)
	// -------------------------------------------------------------------

	public function handle_connect() {
		$this->require_capability_and_nonce( 'arling_asistent_connect', 'arling_asistent_connect_nonce' );

		$consent = isset( $_POST['arling_asistent_consent'] ) && '1' === sanitize_text_field( wp_unslash( $_POST['arling_asistent_consent'] ) );
		if ( ! $consent ) {
			$this->redirect_with_notice( 'error', __( 'Please tick the consent checkbox to connect your store.', 'arling-asistent' ) );
		}

		$email = isset( $_POST['arling_asistent_email'] ) ? sanitize_email( wp_unslash( $_POST['arling_asistent_email'] ) ) : '';
		if ( empty( $email ) || ! is_email( $email ) ) {
			$this->redirect_with_notice( 'error', __( 'Please enter a valid contact e-mail address.', 'arling-asistent' ) );
		}

		$feed_url = $this->default_feed_url();
		$domain   = $this->default_domain();

		if ( empty( $domain ) ) {
			$this->redirect_with_notice( 'error', __( 'Could not determine this site\'s domain.', 'arling-asistent' ) );
		}

		$result = Arling_Asistent_Api::create_tenant( $feed_url, $domain, $email );

		if ( empty( $result['ok'] ) ) {
			$this->redirect_with_notice(
				'error',
				sprintf(
					/* translators: %s: error detail returned by the ARLing Asistent API. */
					__( 'Could not connect to ARLing Asistent: %s', 'arling-asistent' ),
					isset( $result['message'] ) && $result['message'] ? $result['message'] : ( isset( $result['error'] ) ? $result['error'] : __( 'unknown error', 'arling-asistent' ) )
				)
			);
		}

		$data = $result['data'];
		if ( empty( $data['id'] ) ) {
			$this->redirect_with_notice( 'error', __( 'ARLing Asistent did not return a tenant id. Please try again.', 'arling-asistent' ) );
		}

		update_option( 'arling_asistent_tenant_id', sanitize_text_field( $data['id'] ) );
		update_option( 'arling_asistent_domain', $domain );
		update_option( 'arling_asistent_email', $email );
		update_option( 'arling_asistent_connected_at', time() );
		delete_transient( 'arling_asistent_status_' . sanitize_text_field( $data['id'] ) );

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
		if ( false === get_option( 'arling_asistent_display_scope', false ) ) {
			update_option( 'arling_asistent_display_scope', 'shop' );
		}

		$this->redirect_with_notice( 'success', __( 'Connected. Your product feed is now being processed, this can take a few minutes.', 'arling-asistent' ) );
	}

	public function handle_disconnect() {
		$this->require_capability_and_nonce( 'arling_asistent_disconnect', 'arling_asistent_disconnect_nonce' );

		$tenant_id = get_option( 'arling_asistent_tenant_id', '' );
		if ( $tenant_id ) {
			delete_transient( 'arling_asistent_status_' . $tenant_id );
		}

		delete_option( 'arling_asistent_tenant_id' );
		delete_option( 'arling_asistent_domain' );
		delete_option( 'arling_asistent_email' );
		delete_option( 'arling_asistent_connected_at' );

		$this->redirect_with_notice( 'success', __( 'Disconnected. The widget will no longer appear on your site.', 'arling-asistent' ) );
	}

	public function handle_save_settings() {
		$this->require_capability_and_nonce( 'arling_asistent_save_settings', 'arling_asistent_save_settings_nonce' );

		$lang = isset( $_POST['arling_asistent_lang'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_lang'] ) ) : 'auto';
		if ( ! in_array( $lang, array( 'auto', 'sk', 'cs', 'en', 'de' ), true ) ) {
			$lang = 'auto';
		}

		$color = isset( $_POST['arling_asistent_color'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_color'] ) ) : 'auto';
		if ( ! in_array( $color, array( 'auto', 'light', 'dark' ), true ) ) {
			$color = 'auto';
		}

		$position = isset( $_POST['arling_asistent_position'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_position'] ) ) : 'bottom-right';
		if ( ! in_array( $position, array( 'bottom-right', 'bottom-left' ), true ) ) {
			$position = 'bottom-right';
		}

		$scope = isset( $_POST['arling_asistent_display_scope'] ) ? sanitize_text_field( wp_unslash( $_POST['arling_asistent_display_scope'] ) ) : 'shop';
		if ( ! in_array( $scope, array( 'disabled', 'shop', 'all' ), true ) ) {
			$scope = 'shop';
		}

		update_option( 'arling_asistent_lang', $lang );
		update_option( 'arling_asistent_color', $color );
		update_option( 'arling_asistent_position', $position );
		update_option( 'arling_asistent_display_scope', $scope );

		$this->redirect_with_notice( 'success', __( 'Settings saved.', 'arling-asistent' ) );
	}

	public function handle_refresh_status() {
		$this->require_capability_and_nonce( 'arling_asistent_refresh_status', 'arling_asistent_refresh_status_nonce' );

		$tenant_id = get_option( 'arling_asistent_tenant_id', '' );
		if ( $tenant_id ) {
			delete_transient( 'arling_asistent_status_' . $tenant_id );
			// fetch_status() below will repopulate the transient on render.
		}

		wp_safe_redirect( $this->settings_url() );
		exit;
	}

	/**
	 * Fetch tenant status, cached in a transient for STATUS_CACHE_TTL
	 * seconds so simply loading (or auto-refreshing) the settings page does
	 * not hammer the ARLing Asistent API on every page view.
	 *
	 * @param string $tenant_id
	 * @return array|null Status data array, or null if the request failed
	 *                     and nothing usable is cached.
	 */
	private function fetch_status( $tenant_id ) {
		$cache_key = 'arling_asistent_status_' . $tenant_id;
		$cached    = get_transient( $cache_key );
		if ( false !== $cached ) {
			return $cached;
		}

		$result = Arling_Asistent_Api::get_status( $tenant_id );
		if ( empty( $result['ok'] ) ) {
			return null;
		}

		set_transient( $cache_key, $result['data'], self::STATUS_CACHE_TTL );
		return $result['data'];
	}

	// -------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------

	public function render_page() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'arling-asistent' ), 403 );
		}

		$tenant_id = get_option( 'arling_asistent_tenant_id', '' );
		$status    = $tenant_id ? $this->fetch_status( $tenant_id ) : null;

		echo '<div class="wrap arling-asistent-settings">';
		echo '<h1>' . esc_html__( 'ARLing Asistent', 'arling-asistent' ) . '</h1>';

		$this->render_notice();

		if ( $tenant_id ) {
			$this->render_status_section( $tenant_id, $status );
			echo '<hr />';
			$this->render_settings_form();
			echo '<hr />';
			$this->render_disconnect_section();
		} else {
			$this->render_connect_section();
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

	private function render_connect_section() {
		$feed_url = $this->default_feed_url();
		$domain   = $this->default_domain();
		$email    = get_option( 'admin_email' );
		?>
		<div class="card" style="max-width:700px;padding:1.5em;">
			<h2><?php esc_html_e( 'Connect your store', 'arling-asistent' ); ?></h2>
			<p>
				<?php esc_html_e( 'ARLing Asistent adds an AI chat widget to your store that answers shopper questions using your own product catalogue.', 'arling-asistent' ); ?>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="arling_asistent_connect" />
				<?php wp_nonce_field( 'arling_asistent_connect', 'arling_asistent_connect_nonce' ); ?>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="arling_asistent_email"><?php esc_html_e( 'Contact e-mail', 'arling-asistent' ); ?></label></th>
						<td>
							<input type="email" required id="arling_asistent_email" name="arling_asistent_email" class="regular-text" value="<?php echo esc_attr( $email ); ?>" />
							<p class="description"><?php esc_html_e( 'Used by ARLing to reach you about your assistant (setup issues, billing after the beta).', 'arling-asistent' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'What will be sent', 'arling-asistent' ); ?></th>
						<td>
							<ul style="list-style:disc;margin-left:1.2em;">
								<li><?php
									printf(
										/* translators: %s: the store's public product feed URL. */
										esc_html__( 'Your public product feed URL: %s', 'arling-asistent' ),
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
									esc_html__( 'I agree to send the product feed URL, site domain and e-mail address above to ARLing s. r. o. (Bratislava, Slovakia) to set up my assistant, and I have read the %1$sTerms%3$s and %2$sData Processing Agreement%3$s.', 'arling-asistent' ),
									'<a href="' . esc_url( 'https://arling.sk/podmienky/' ) . '" target="_blank" rel="noopener noreferrer">',
									'<a href="' . esc_url( 'https://arling.sk/asistent/#gdpr' ) . '" target="_blank" rel="noopener noreferrer">',
									'</a>'
								);
								?>
							</label>
						</td>
					</tr>
				</table>

				<?php submit_button( __( 'Connect', 'arling-asistent' ) ); ?>
			</form>
		</div>
		<?php
	}

	private function render_status_section( $tenant_id, $status ) {
		$refresh_url = wp_nonce_url(
			add_query_arg(
				array(
					'action' => 'arling_asistent_refresh_status',
				),
				admin_url( 'admin-post.php' )
			),
			'arling_asistent_refresh_status',
			'arling_asistent_refresh_status_nonce'
		);

		echo '<h2>' . esc_html__( 'Status', 'arling-asistent' ) . '</h2>';

		if ( null === $status ) {
			echo '<p>' . esc_html__( 'Could not reach ARLing Asistent right now. Your connection is saved; please try refreshing in a moment.', 'arling-asistent' ) . '</p>';
			echo '<p><a class="button" href="' . esc_url( $refresh_url ) . '">' . esc_html__( 'Refresh status', 'arling-asistent' ) . '</a></p>';
			return;
		}

		$state = isset( $status['status'] ) ? sanitize_text_field( $status['status'] ) : 'unknown';

		$state_labels = array(
			'pending' => __( 'Processing your product feed…', 'arling-asistent' ),
			'ready'   => __( 'Ready', 'arling-asistent' ),
			'error'   => __( 'There was a problem processing your product feed.', 'arling-asistent' ),
		);
		$label = isset( $state_labels[ $state ] ) ? $state_labels[ $state ] : ucfirst( $state );

		echo '<table class="widefat striped" style="max-width:700px;"><tbody>';
		echo '<tr><th>' . esc_html__( 'Tenant ID', 'arling-asistent' ) . '</th><td><code>' . esc_html( $tenant_id ) . '</code></td></tr>';
		echo '<tr><th>' . esc_html__( 'Status', 'arling-asistent' ) . '</th><td>' . esc_html( $label ) . '</td></tr>';

		if ( isset( $status['plan'] ) ) {
			echo '<tr><th>' . esc_html__( 'Plan', 'arling-asistent' ) . '</th><td>' . esc_html( ucfirst( sanitize_text_field( $status['plan'] ) ) ) . '</td></tr>';
		}
		if ( isset( $status['monthly_quota'] ) ) {
			$used = isset( $status['used_this_month'] ) ? (int) $status['used_this_month'] : 0;
			echo '<tr><th>' . esc_html__( 'Conversations this month', 'arling-asistent' ) . '</th><td>' .
				esc_html( sprintf( '%1$d / %2$d', $used, (int) $status['monthly_quota'] ) ) . '</td></tr>';
		}
		// product_count is not part of the current API response; shown only
		// if a future API version adds it, so this never displays a blank
		// or fabricated value in the meantime.
		if ( isset( $status['product_count'] ) ) {
			echo '<tr><th>' . esc_html__( 'Products indexed', 'arling-asistent' ) . '</th><td>' . esc_html( (int) $status['product_count'] ) . '</td></tr>';
		}
		if ( ! empty( $status['last_ingested_at'] ) ) {
			echo '<tr><th>' . esc_html__( 'Last updated', 'arling-asistent' ) . '</th><td>' . esc_html( sanitize_text_field( $status['last_ingested_at'] ) ) . '</td></tr>';
		}
		echo '</tbody></table>';

		echo '<p><a class="button" href="' . esc_url( $refresh_url ) . '">' . esc_html__( 'Refresh status', 'arling-asistent' ) . '</a></p>';

		if ( 'pending' === $state ) {
			echo '<p class="description">' . esc_html__( 'This page will refresh automatically in 10 seconds.', 'arling-asistent' ) . '</p>';
			// Simple no-JS auto-poll while ingestion is running, limited to
			// this one settings screen only (never on the public site).
			echo '<meta http-equiv="refresh" content="10;url=' . esc_url( $this->settings_url() ) . '" />';
		}
	}

	private function render_settings_form() {
		$lang     = get_option( 'arling_asistent_lang', 'auto' );
		$color    = get_option( 'arling_asistent_color', 'auto' );
		$position = get_option( 'arling_asistent_position', 'bottom-right' );
		$scope    = get_option( 'arling_asistent_display_scope', 'shop' );
		?>
		<h2><?php esc_html_e( 'Widget settings', 'arling-asistent' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="arling_asistent_save_settings" />
			<?php wp_nonce_field( 'arling_asistent_save_settings', 'arling_asistent_save_settings_nonce' ); ?>

			<table class="form-table" role="presentation">
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
						<p class="description"><?php esc_html_e( 'The current widget version always opens in the bottom-right corner; this setting will take effect once positioning support ships in the widget.', 'arling-asistent' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="arling_asistent_display_scope"><?php esc_html_e( 'Show widget on', 'arling-asistent' ); ?></label></th>
					<td>
						<select id="arling_asistent_display_scope" name="arling_asistent_display_scope">
							<?php
							$options = array(
								'shop'     => __( 'WooCommerce pages only (shop, product, cart, checkout, account)', 'arling-asistent' ),
								'all'      => __( 'All pages', 'arling-asistent' ),
								'disabled' => __( 'Nowhere (temporarily disable the widget)', 'arling-asistent' ),
							);
							foreach ( $options as $value => $text ) {
								echo '<option value="' . esc_attr( $value ) . '" ' . selected( $scope, $value, false ) . '>' . esc_html( $text ) . '</option>';
							}
							?>
						</select>
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
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect ARLing Asistent from this store?', 'arling-asistent' ) ); ?>');">
			<input type="hidden" name="action" value="arling_asistent_disconnect" />
			<?php wp_nonce_field( 'arling_asistent_disconnect', 'arling_asistent_disconnect_nonce' ); ?>
			<?php submit_button( __( 'Disconnect', 'arling-asistent' ), 'delete' ); ?>
		</form>
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
