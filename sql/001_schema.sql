-- Generado por backend/scripts/export_ddl.py. No editar a mano.
SET XACT_ABORT ON;
BEGIN TRAN;

CREATE TABLE login_attempts (
	[key] VARCHAR(160) NOT NULL, 
	failures INTEGER NOT NULL, 
	window_start DATETIME2 NOT NULL, 
	locked_until DATETIME2 NULL, 
	PRIMARY KEY ([key])
);

CREATE TABLE outbox_emails (
	id INTEGER NOT NULL IDENTITY, 
	to_address NVARCHAR(254) NOT NULL, 
	subject NVARCHAR(250) NOT NULL, 
	html NVARCHAR(max) NOT NULL, 
	text NVARCHAR(max) NOT NULL, 
	kind VARCHAR(40) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	attempts INTEGER NOT NULL, 
	last_error NVARCHAR(1000) NULL, 
	created_at DATETIME2 NOT NULL, 
	next_attempt_at DATETIME2 NOT NULL, 
	locked_until DATETIME2 NULL, 
	sent_at DATETIME2 NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_outbox_emails_pending ON outbox_emails (status, next_attempt_at);
CREATE TABLE plans (
	code VARCHAR(40) NOT NULL, 
	name NVARCHAR(120) NOT NULL, 
	audience VARCHAR(20) NOT NULL, 
	price_pen_month NUMERIC(10, 2) NULL, 
	price_pen_year NUMERIC(10, 2) NULL, 
	features NVARCHAR(max) NOT NULL, 
	sort_order INTEGER NOT NULL, 
	PRIMARY KEY (code)
);

CREATE TABLE users (
	id INTEGER NOT NULL IDENTITY, 
	username VARCHAR(80) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	person_id INTEGER NULL, 
	is_active BIT NOT NULL, 
	is_admin BIT NOT NULL, 
	token_version INTEGER NOT NULL, 
	must_change_password BIT NOT NULL, 
	display_name NVARCHAR(200) NOT NULL, 
	email NVARCHAR(254) NULL, 
	email_verified_at DATETIME2 NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	UNIQUE (username), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE email IS NOT NULL;
CREATE TABLE audit_log (
	id INTEGER NOT NULL IDENTITY, 
	at DATETIME2 NOT NULL, 
	user_id INTEGER NULL, 
	tournament_id INTEGER NULL, 
	entity VARCHAR(40) NOT NULL, 
	entity_id VARCHAR(40) NOT NULL, 
	action VARCHAR(40) NOT NULL, 
	before NVARCHAR(max) NULL, 
	after NVARCHAR(max) NULL, 
	reason NVARCHAR(1000) NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_log_tournament_id ON audit_log (tournament_id);
CREATE TABLE email_verifications (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NOT NULL, 
	email NVARCHAR(254) NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	expires_at DATETIME2 NOT NULL, 
	used_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	UNIQUE (token_hash)
);

CREATE INDEX ix_email_verifications_user_id ON email_verifications (user_id);
CREATE TABLE organizations (
	id INTEGER NOT NULL IDENTITY, 
	name NVARCHAR(200) NOT NULL, 
	slug VARCHAR(80) NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	country VARCHAR(2) NOT NULL DEFAULT 'PE', 
	timezone VARCHAR(60) NOT NULL DEFAULT 'America/Lima', 
	currency VARCHAR(3) NOT NULL DEFAULT 'PEN', 
	logo NVARCHAR(500) NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (slug), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE TABLE password_resets (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	expires_at DATETIME2 NOT NULL, 
	used_at DATETIME2 NULL, 
	ip VARCHAR(45) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	UNIQUE (token_hash)
);

CREATE INDEX ix_password_resets_user_id ON password_resets (user_id);
CREATE TABLE persons (
	id INTEGER NOT NULL IDENTITY, 
	first_names NVARCHAR(120) NOT NULL, 
	last_names NVARCHAR(120) NOT NULL, 
	normalized_name NVARCHAR(250) NOT NULL, 
	birth_date DATE NULL, 
	sex VARCHAR(1) NOT NULL, 
	identity_incomplete BIT NOT NULL, 
	merged_into_id INTEGER NULL, 
	anonymized_at DATETIME2 NULL, 
	is_test_data BIT NOT NULL, 
	public_id VARCHAR(24) NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(merged_into_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_persons_normalized_name ON persons (normalized_name);
CREATE UNIQUE INDEX uq_persons_public_id ON persons (public_id) WHERE public_id IS NOT NULL;
CREATE TABLE push_subscriptions (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NULL, 
	endpoint VARCHAR(800) NOT NULL, 
	p256dh VARCHAR(120) NOT NULL, 
	auth VARCHAR(60) NOT NULL, 
	user_agent NVARCHAR(255) NOT NULL, 
	preferences NVARCHAR(max) NULL, 
	created_at DATETIME2 NOT NULL, 
	last_success_at DATETIME2 NULL, 
	failures INTEGER NOT NULL DEFAULT '0', 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	UNIQUE (endpoint)
);

CREATE INDEX ix_push_subscriptions_user_id ON push_subscriptions (user_id);
CREATE TABLE ranking_seasons (
	id INTEGER NOT NULL IDENTITY, 
	name NVARCHAR(200) NOT NULL, 
	slug VARCHAR(80) NOT NULL, 
	year INTEGER NOT NULL, 
	date_from DATE NULL, 
	date_to DATE NULL, 
	tournament_ids NVARCHAR(max) NOT NULL, 
	points NVARCHAR(max) NOT NULL, 
	multipliers NVARCHAR(max) NOT NULL, 
	min_entrants_walkover_gold INTEGER NOT NULL, 
	is_public BIT NOT NULL DEFAULT 0, 
	computed_at DATETIME2 NULL, 
	source_fingerprint VARCHAR(120) NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (slug), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE TABLE rule_overrides (
	id INTEGER NOT NULL IDENTITY, 
	entity VARCHAR(40) NOT NULL, 
	entity_id INTEGER NOT NULL, 
	code VARCHAR(40) NOT NULL, 
	message NVARCHAR(500) NOT NULL, 
	reason NVARCHAR(500) NOT NULL, 
	user_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE INDEX ix_rule_overrides_entity ON rule_overrides (entity, entity_id);
CREATE TABLE user_sessions (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	previous_token_hash VARCHAR(64) NULL, 
	rotated_at DATETIME2 NULL, 
	created_at DATETIME2 NOT NULL, 
	last_used_at DATETIME2 NOT NULL, 
	expires_at DATETIME2 NOT NULL, 
	revoked_at DATETIME2 NULL, 
	user_agent NVARCHAR(255) NOT NULL, 
	ip VARCHAR(45) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	UNIQUE (token_hash)
);

CREATE INDEX ix_user_sessions_previous_token_hash ON user_sessions (previous_token_hash);
CREATE INDEX ix_user_sessions_user_id ON user_sessions (user_id);
CREATE TABLE category_templates (
	id INTEGER NOT NULL IDENTITY, 
	name NVARCHAR(200) NOT NULL, 
	description NVARCHAR(1000) NOT NULL, 
	organization_id INTEGER NULL, 
	is_archived BIT NOT NULL DEFAULT 0, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(organization_id) REFERENCES organizations (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_category_templates_organization_id ON category_templates (organization_id);
CREATE TABLE data_consents (
	id INTEGER NOT NULL IDENTITY, 
	person_id INTEGER NOT NULL, 
	given_by NVARCHAR(200) NOT NULL, 
	relationship_to_person NVARCHAR(60) NOT NULL, 
	given_on DATE NOT NULL, 
	medium NVARCHAR(60) NOT NULL, 
	scope NVARCHAR(250) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_data_consents_person_id ON data_consents (person_id);
CREATE TABLE dojos (
	id INTEGER NOT NULL IDENTITY, 
	name NVARCHAR(200) NOT NULL, 
	short_name NVARCHAR(40) NOT NULL, 
	city NVARCHAR(100) NOT NULL, 
	is_claimed BIT NOT NULL, 
	is_independent BIT NOT NULL, 
	organization_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(organization_id) REFERENCES organizations (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_dojos_organization_id ON dojos (organization_id);
CREATE TABLE grade_history (
	id INTEGER NOT NULL IDENTITY, 
	person_id INTEGER NOT NULL, 
	grade VARCHAR(20) NOT NULL, 
	grade_ordinal INTEGER NOT NULL, 
	awarded_on DATE NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_grade_history_person_id ON grade_history (person_id);
CREATE TABLE identity_documents (
	id INTEGER NOT NULL IDENTITY, 
	person_id INTEGER NOT NULL, 
	doc_type VARCHAR(20) NOT NULL, 
	number VARCHAR(30) NOT NULL, 
	normalized_number VARCHAR(30) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_document UNIQUE (doc_type, normalized_number), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_identity_documents_person_id ON identity_documents (person_id);
CREATE TABLE organization_members (
	id INTEGER NOT NULL IDENTITY, 
	organization_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_organization_member UNIQUE (organization_id, user_id), 
	FOREIGN KEY(organization_id) REFERENCES organizations (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE INDEX ix_organization_members_user_id ON organization_members (user_id);
CREATE TABLE person_merges (
	id INTEGER NOT NULL IDENTITY, 
	kept_person_id INTEGER NOT NULL, 
	merged_person_id INTEGER NOT NULL, 
	moved NVARCHAR(max) NOT NULL, 
	reason NVARCHAR(500) NOT NULL, 
	merged_at DATETIME2 NOT NULL, 
	merged_by_id INTEGER NULL, 
	reverted_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(kept_person_id) REFERENCES persons (id), 
	FOREIGN KEY(merged_person_id) REFERENCES persons (id), 
	FOREIGN KEY(merged_by_id) REFERENCES users (id)
);

CREATE TABLE person_roles (
	id INTEGER NOT NULL IDENTITY, 
	person_id INTEGER NOT NULL, 
	role VARCHAR(30) NOT NULL, 
	scope_type VARCHAR(20) NOT NULL, 
	scope_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_person_roles_person_id ON person_roles (person_id);
CREATE INDEX ix_person_roles_scope ON person_roles (role, scope_type, scope_id);
CREATE TABLE subscriptions (
	id INTEGER NOT NULL IDENTITY, 
	organization_id INTEGER NULL, 
	person_id INTEGER NULL, 
	user_id INTEGER NULL, 
	plan_code VARCHAR(40) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	current_period_end DATETIME2 NULL, 
	source VARCHAR(20) NOT NULL, 
	reference VARCHAR(120) NULL, 
	notes NVARCHAR(500) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(organization_id) REFERENCES organizations (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	FOREIGN KEY(plan_code) REFERENCES plans (code), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE INDEX ix_subscriptions_organization_id ON subscriptions (organization_id);
CREATE INDEX ix_subscriptions_person_id ON subscriptions (person_id);
CREATE INDEX ix_subscriptions_user_id ON subscriptions (user_id);
CREATE TABLE branches (
	id INTEGER NOT NULL IDENTITY, 
	dojo_id INTEGER NOT NULL, 
	name NVARCHAR(120) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_branches_dojo_id ON branches (dojo_id);
CREATE TABLE profile_claims (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NOT NULL, 
	person_id INTEGER NOT NULL, 
	relationship VARCHAR(20) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	evidence NVARCHAR(500) NOT NULL, 
	document_match BIT NULL, 
	consent_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	reviewed_by_id INTEGER NULL, 
	reviewed_at DATETIME2 NULL, 
	reason NVARCHAR(500) NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(consent_id) REFERENCES data_consents (id), 
	FOREIGN KEY(reviewed_by_id) REFERENCES users (id)
);

CREATE INDEX ix_profile_claims_person_id ON profile_claims (person_id);
CREATE INDEX ix_profile_claims_status ON profile_claims (status, person_id);
CREATE INDEX ix_profile_claims_user_id ON profile_claims (user_id);
CREATE TABLE ranking_entries (
	id INTEGER NOT NULL IDENTITY, 
	season_id INTEGER NOT NULL, 
	kind VARCHAR(10) NOT NULL, 
	group_key VARCHAR(200) NOT NULL, 
	group_label NVARCHAR(200) NOT NULL, 
	modality VARCHAR(10) NOT NULL, 
	person_id INTEGER NULL, 
	dojo_id INTEGER NULL, 
	points NUMERIC(9, 2) NOT NULL, 
	rank INTEGER NOT NULL, 
	golds INTEGER NOT NULL, 
	silvers INTEGER NOT NULL, 
	bronzes INTEGER NOT NULL, 
	participations INTEGER NOT NULL, 
	tournaments INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(season_id) REFERENCES ranking_seasons (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id)
);

CREATE INDEX ix_ranking_entries_person ON ranking_entries (person_id);
CREATE INDEX ix_ranking_entries_season ON ranking_entries (season_id, kind, group_key);
CREATE TABLE template_categories (
	id INTEGER NOT NULL IDENTITY, 
	template_id INTEGER NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	code VARCHAR(40) NOT NULL, 
	name NVARCHAR(200) NOT NULL, 
	modality VARCHAR(10) NOT NULL, 
	is_team BIT NOT NULL, 
	sex VARCHAR(1) NOT NULL, 
	age_min INTEGER NULL, 
	age_max INTEGER NULL, 
	grade_min INTEGER NULL, 
	grade_max INTEGER NULL, 
	weight_class VARCHAR(20) NULL, 
	format VARCHAR(30) NULL, 
	third_place_rule VARCHAR(30) NULL, 
	duration_seconds INTEGER NULL, 
	kumite_rules NVARCHAR(max) NULL, 
	kata_method VARCHAR(20) NULL, 
	kata_structure VARCHAR(20) NULL, 
	kata_judges INTEGER NULL, 
	sort_order INTEGER NOT NULL, 
	max_entrants INTEGER NULL, 
	weight_min_kg NUMERIC(5, 1) NULL, 
	weight_max_kg NUMERIC(5, 1) NULL, 
	kata_rules NVARCHAR(max) NULL, 
	competition_rules NVARCHAR(max) NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(template_id) REFERENCES category_templates (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_template_categories_template_id ON template_categories (template_id);
CREATE TABLE tournaments (
	id INTEGER NOT NULL IDENTITY, 
	name NVARCHAR(200) NOT NULL, 
	start_date DATE NOT NULL, 
	end_date DATE NULL, 
	venue NVARCHAR(200) NOT NULL, 
	city NVARCHAR(100) NOT NULL, 
	status VARCHAR(30) NOT NULL, 
	is_test BIT NOT NULL, 
	age_reference_date DATE NOT NULL, 
	default_format VARCHAR(30) NOT NULL, 
	default_third_place_rule VARCHAR(30) NOT NULL, 
	kumite_rules NVARCHAR(max) NOT NULL, 
	kata_defaults NVARCHAR(max) NOT NULL, 
	competition_rules NVARCHAR(max) NULL, 
	age_mode VARCHAR(10) NOT NULL DEFAULT 'date', 
	template_id INTEGER NULL, 
	public_token VARCHAR(40) NULL, 
	public_names VARCHAR(10) NOT NULL DEFAULT 'short', 
	organization_id INTEGER NOT NULL, 
	self_registration_open BIT NOT NULL DEFAULT 0, 
	self_registration_closes_at DATETIME2 NULL, 
	checkin_required BIT NOT NULL DEFAULT 0, 
	weigh_in_tolerance_kg NUMERIC(4, 2) NOT NULL DEFAULT '0', 
	certificate_organizer NVARCHAR(200) NOT NULL DEFAULT '', 
	certificate_signer_name NVARCHAR(200) NOT NULL DEFAULT '', 
	certificate_signer_title NVARCHAR(200) NOT NULL DEFAULT '', 
	public_slug VARCHAR(80) NULL, 
	timezone VARCHAR(40) NOT NULL DEFAULT 'America/Lima', 
	match_overhead_seconds INTEGER NOT NULL DEFAULT '60', 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(template_id) REFERENCES category_templates (id), 
	FOREIGN KEY(organization_id) REFERENCES organizations (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_tournaments_organization_id ON tournaments (organization_id);
CREATE UNIQUE INDEX uq_tournaments_public_slug ON tournaments (public_slug) WHERE public_slug IS NOT NULL;
CREATE UNIQUE INDEX uq_tournaments_public_token ON tournaments (public_token) WHERE public_token IS NOT NULL;
CREATE TABLE dojo_memberships (
	id INTEGER NOT NULL IDENTITY, 
	person_id INTEGER NOT NULL, 
	dojo_id INTEGER NOT NULL, 
	branch_id INTEGER NULL, 
	start_date DATE NOT NULL, 
	end_date DATE NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	FOREIGN KEY(branch_id) REFERENCES branches (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_dojo_memberships_dojo_id ON dojo_memberships (dojo_id);
CREATE INDEX ix_dojo_memberships_person_id ON dojo_memberships (person_id);
CREATE TABLE guardianships (
	id INTEGER NOT NULL IDENTITY, 
	user_id INTEGER NOT NULL, 
	person_id INTEGER NOT NULL, 
	relationship VARCHAR(20) NOT NULL, 
	claim_id INTEGER NULL, 
	verified_at DATETIME2 NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_guardianship UNIQUE (user_id, person_id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(claim_id) REFERENCES profile_claims (id)
);

CREATE INDEX ix_guardianships_person_id ON guardianships (person_id);
CREATE INDEX ix_guardianships_user_id ON guardianships (user_id);
CREATE TABLE import_batches (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	filename NVARCHAR(255) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_import_batches_tournament_id ON import_batches (tournament_id);
CREATE TABLE notification_outbox (
	id INTEGER NOT NULL IDENTITY, 
	subscription_id INTEGER NOT NULL, 
	tournament_id INTEGER NULL, 
	kind VARCHAR(20) NOT NULL, 
	ref VARCHAR(60) NOT NULL, 
	title NVARCHAR(200) NOT NULL, 
	body NVARCHAR(500) NOT NULL, 
	url NVARCHAR(500) NOT NULL, 
	tag VARCHAR(80) NOT NULL, 
	ttl INTEGER NOT NULL, 
	urgency VARCHAR(10) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	attempts INTEGER NOT NULL, 
	last_error NVARCHAR(500) NULL, 
	created_at DATETIME2 NOT NULL, 
	next_attempt_at DATETIME2 NOT NULL, 
	locked_until DATETIME2 NULL, 
	claimed_by VARCHAR(40) NULL, 
	expires_at DATETIME2 NULL, 
	sent_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_notification_outbox_dedup UNIQUE (subscription_id, kind, ref), 
	FOREIGN KEY(subscription_id) REFERENCES push_subscriptions (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id)
);

CREATE INDEX ix_notification_outbox_pending ON notification_outbox (status, next_attempt_at);
CREATE INDEX ix_notification_outbox_tournament_id ON notification_outbox (tournament_id);
CREATE TABLE public_snapshots (
	tournament_id INTEGER NOT NULL, 
	kind VARCHAR(40) NOT NULL, 
	payload NVARCHAR(max) NULL, 
	etag VARCHAR(40) NULL, 
	computed_at DATETIME2 NULL, 
	dirty BIT NOT NULL DEFAULT 0, 
	lease_until DATETIME2 NULL, 
	PRIMARY KEY (tournament_id, kind), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id)
);

CREATE TABLE push_follows (
	id INTEGER NOT NULL IDENTITY, 
	subscription_id INTEGER NOT NULL, 
	tournament_id INTEGER NULL, 
	person_key VARCHAR(24) NULL, 
	person_id INTEGER NULL, 
	dojo_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	expires_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(subscription_id) REFERENCES push_subscriptions (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id)
);

CREATE INDEX ix_push_follows_dojo_id ON push_follows (dojo_id);
CREATE INDEX ix_push_follows_key ON push_follows (tournament_id, person_key);
CREATE INDEX ix_push_follows_person_id ON push_follows (person_id);
CREATE INDEX ix_push_follows_subscription_id ON push_follows (subscription_id);
CREATE TABLE referee_assignments (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	person_id INTEGER NOT NULL, 
	target_type VARCHAR(20) NOT NULL, 
	target_id INTEGER NOT NULL, 
	position NVARCHAR(40) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE INDEX ix_referee_assignments_person_id ON referee_assignments (person_id);
CREATE INDEX ix_referee_assignments_target ON referee_assignments (tournament_id, target_type, target_id);
CREATE TABLE tatamis (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	number INTEGER NOT NULL, 
	name NVARCHAR(60) NOT NULL, 
	planned_start DATETIME2 NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_tatamis_tournament_id ON tatamis (tournament_id);
CREATE TABLE teams (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	dojo_id INTEGER NOT NULL, 
	name NVARCHAR(120) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_teams_tournament_id ON teams (tournament_id);
CREATE TABLE tournament_invitations (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	dojo_id INTEGER NULL, 
	token VARCHAR(64) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	revoked_at DATETIME2 NULL, 
	uses INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	UNIQUE (token), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE INDEX ix_tournament_invitations_tournament_id ON tournament_invitations (tournament_id);
CREATE TABLE categories (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	tatami_id INTEGER NULL, 
	queue_position INTEGER NULL, 
	merged_into_id INTEGER NULL, 
	cancel_reason NVARCHAR(500) NULL, 
	is_manual BIT NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	code VARCHAR(40) NOT NULL, 
	name NVARCHAR(200) NOT NULL, 
	modality VARCHAR(10) NOT NULL, 
	is_team BIT NOT NULL, 
	sex VARCHAR(1) NOT NULL, 
	age_min INTEGER NULL, 
	age_max INTEGER NULL, 
	grade_min INTEGER NULL, 
	grade_max INTEGER NULL, 
	weight_class VARCHAR(20) NULL, 
	format VARCHAR(30) NULL, 
	third_place_rule VARCHAR(30) NULL, 
	duration_seconds INTEGER NULL, 
	kumite_rules NVARCHAR(max) NULL, 
	kata_method VARCHAR(20) NULL, 
	kata_structure VARCHAR(20) NULL, 
	kata_judges INTEGER NULL, 
	sort_order INTEGER NOT NULL, 
	max_entrants INTEGER NULL, 
	weight_min_kg NUMERIC(5, 1) NULL, 
	weight_max_kg NUMERIC(5, 1) NULL, 
	kata_rules NVARCHAR(max) NULL, 
	competition_rules NVARCHAR(max) NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(tatami_id) REFERENCES tatamis (id), 
	FOREIGN KEY(merged_into_id) REFERENCES categories (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_categories_tatami ON categories (tatami_id, status, queue_position);
CREATE INDEX ix_categories_tournament ON categories (tournament_id, status);
CREATE TABLE dojo_admin_requests (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	invitation_id INTEGER NULL, 
	dojo_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	decided_at DATETIME2 NULL, 
	decided_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(invitation_id) REFERENCES tournament_invitations (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	FOREIGN KEY(decided_by_id) REFERENCES users (id)
);

CREATE INDEX ix_dojo_admin_requests_tournament_id ON dojo_admin_requests (tournament_id);
CREATE TABLE import_rows (
	id INTEGER NOT NULL IDENTITY, 
	batch_id INTEGER NOT NULL, 
	row_number INTEGER NOT NULL, 
	data NVARCHAR(max) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	errors NVARCHAR(max) NOT NULL, 
	duplicates NVARCHAR(max) NOT NULL, 
	suggested_category_ids NVARCHAR(max) NOT NULL, 
	resolution NVARCHAR(max) NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(batch_id) REFERENCES import_batches (id)
);

CREATE INDEX ix_import_rows_batch_id ON import_rows (batch_id);
CREATE TABLE team_members (
	id INTEGER NOT NULL IDENTITY, 
	team_id INTEGER NOT NULL, 
	person_id INTEGER NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	[order] INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (team_id, person_id), 
	FOREIGN KEY(team_id) REFERENCES teams (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id)
);

CREATE INDEX ix_team_members_person_id ON team_members (person_id);
CREATE INDEX ix_team_members_team_id ON team_members (team_id);
CREATE TABLE brackets (
	id INTEGER NOT NULL IDENTITY, 
	category_id INTEGER NOT NULL, 
	current_version_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (category_id), 
	FOREIGN KEY(category_id) REFERENCES categories (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE TABLE category_merges (
	id INTEGER NOT NULL IDENTITY, 
	target_category_id INTEGER NOT NULL, 
	source_category_id INTEGER NOT NULL, 
	moved_registration_ids NVARCHAR(max) NOT NULL, 
	reason NVARCHAR(500) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	undone_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(target_category_id) REFERENCES categories (id), 
	FOREIGN KEY(source_category_id) REFERENCES categories (id), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE TABLE category_splits (
	id INTEGER NOT NULL IDENTITY, 
	source_category_id INTEGER NOT NULL, 
	new_category_id INTEGER NOT NULL, 
	criterion VARCHAR(20) NOT NULL, 
	moved_registration_ids NVARCHAR(max) NOT NULL, 
	before NVARCHAR(max) NOT NULL, 
	reason NVARCHAR(500) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	undone_at DATETIME2 NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(source_category_id) REFERENCES categories (id), 
	FOREIGN KEY(new_category_id) REFERENCES categories (id), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE TABLE registrations (
	id INTEGER NOT NULL IDENTITY, 
	tournament_id INTEGER NOT NULL, 
	category_id INTEGER NOT NULL, 
	original_category_id INTEGER NOT NULL, 
	person_id INTEGER NULL, 
	team_id INTEGER NULL, 
	dojo_id INTEGER NOT NULL, 
	branch_id INTEGER NULL, 
	grade VARCHAR(20) NULL, 
	grade_ordinal INTEGER NULL, 
	weight_class VARCHAR(20) NULL, 
	age_at_reference INTEGER NULL, 
	status VARCHAR(20) NOT NULL, 
	withdrawn_reason NVARCHAR(500) NULL, 
	requested_by_id INTEGER NULL, 
	rejection_reason NVARCHAR(500) NULL, 
	seed INTEGER NULL, 
	checkin_status VARCHAR(10) NOT NULL DEFAULT 'pending', 
	checked_in_at DATETIME2 NULL, 
	checked_in_by_id INTEGER NULL, 
	weight_kg NUMERIC(5, 2) NULL, 
	weighed_at DATETIME2 NULL, 
	weigh_in_result VARCHAR(10) NULL, 
	credential_code VARCHAR(12) NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tournament_id) REFERENCES tournaments (id), 
	FOREIGN KEY(category_id) REFERENCES categories (id), 
	FOREIGN KEY(original_category_id) REFERENCES categories (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id), 
	FOREIGN KEY(team_id) REFERENCES teams (id), 
	FOREIGN KEY(dojo_id) REFERENCES dojos (id), 
	FOREIGN KEY(branch_id) REFERENCES branches (id), 
	FOREIGN KEY(requested_by_id) REFERENCES users (id), 
	FOREIGN KEY(checked_in_by_id) REFERENCES users (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_registrations_category ON registrations (category_id, status);
CREATE INDEX ix_registrations_dojo_id ON registrations (dojo_id);
CREATE INDEX ix_registrations_person_id ON registrations (person_id);
CREATE INDEX ix_registrations_team_id ON registrations (team_id);
CREATE INDEX ix_registrations_tournament_id ON registrations (tournament_id);
CREATE UNIQUE INDEX uq_registrations_credential_code ON registrations (credential_code) WHERE credential_code IS NOT NULL;
CREATE TABLE bracket_versions (
	id INTEGER NOT NULL IDENTITY, 
	bracket_id INTEGER NOT NULL, 
	number INTEGER NOT NULL, 
	format VARCHAR(30) NOT NULL, 
	third_place_rule VARCHAR(30) NOT NULL, 
	seed INTEGER NOT NULL, 
	size INTEGER NOT NULL, 
	slots NVARCHAR(max) NOT NULL, 
	same_dojo_first_round INTEGER NOT NULL, 
	reason NVARCHAR(500) NOT NULL, 
	created_at DATETIME2 NOT NULL, 
	created_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	UNIQUE (bracket_id, number), 
	FOREIGN KEY(bracket_id) REFERENCES brackets (id), 
	FOREIGN KEY(created_by_id) REFERENCES users (id)
);

CREATE TABLE category_results (
	id INTEGER NOT NULL IDENTITY, 
	category_id INTEGER NOT NULL, 
	registration_id INTEGER NOT NULL, 
	place INTEGER NOT NULL, 
	computed_at DATETIME2 NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (category_id, registration_id), 
	FOREIGN KEY(category_id) REFERENCES categories (id), 
	FOREIGN KEY(registration_id) REFERENCES registrations (id)
);

CREATE INDEX ix_category_results_category_id ON category_results (category_id);
CREATE INDEX ix_category_results_registration_id ON category_results (registration_id);
CREATE TABLE matches (
	id INTEGER NOT NULL IDENTITY, 
	category_id INTEGER NOT NULL, 
	bracket_version_id INTEGER NOT NULL, 
	code VARCHAR(20) NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	round INTEGER NOT NULL, 
	position INTEGER NOT NULL, 
	aka_source VARCHAR(40) NOT NULL, 
	ao_source VARCHAR(40) NOT NULL, 
	aka_registration_id INTEGER NULL, 
	ao_registration_id INTEGER NULL, 
	status VARCHAR(20) NOT NULL, 
	winner_registration_id INTEGER NULL, 
	method VARCHAR(30) NULL, 
	aka_score INTEGER NULL, 
	ao_score INTEGER NULL, 
	started_at DATETIME2 NULL, 
	finished_at DATETIME2 NULL, 
	is_current BIT NOT NULL, 
	parent_match_id INTEGER NULL, 
	bout_number INTEGER NULL, 
	aka_person_id INTEGER NULL, 
	ao_person_id INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (bracket_version_id, code), 
	FOREIGN KEY(category_id) REFERENCES categories (id), 
	FOREIGN KEY(bracket_version_id) REFERENCES bracket_versions (id), 
	FOREIGN KEY(aka_registration_id) REFERENCES registrations (id), 
	FOREIGN KEY(ao_registration_id) REFERENCES registrations (id), 
	FOREIGN KEY(winner_registration_id) REFERENCES registrations (id), 
	FOREIGN KEY(parent_match_id) REFERENCES matches (id), 
	FOREIGN KEY(aka_person_id) REFERENCES persons (id), 
	FOREIGN KEY(ao_person_id) REFERENCES persons (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_matches_aka_registration ON matches (aka_registration_id);
CREATE INDEX ix_matches_ao_registration ON matches (ao_registration_id);
CREATE INDEX ix_matches_category ON matches (category_id, status);
CREATE INDEX ix_matches_category_current ON matches (category_id, is_current);
CREATE INDEX ix_matches_parent_match_id ON matches (parent_match_id);
CREATE TABLE judge_votes (
	id INTEGER NOT NULL IDENTITY, 
	match_id INTEGER NOT NULL, 
	judge_number INTEGER NOT NULL, 
	judge_person_id INTEGER NULL, 
	color VARCHAR(3) NULL, 
	created_at DATETIME2 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(match_id) REFERENCES matches (id), 
	FOREIGN KEY(judge_person_id) REFERENCES persons (id)
);

CREATE INDEX ix_judge_votes_match_id ON judge_votes (match_id);
CREATE TABLE kata_performances (
	id INTEGER NOT NULL IDENTITY, 
	category_id INTEGER NOT NULL, 
	match_id INTEGER NULL, 
	round_number INTEGER NOT NULL, 
	registration_id INTEGER NOT NULL, 
	[order] INTEGER NOT NULL, 
	kata_name NVARCHAR(80) NULL, 
	total NUMERIC(7, 2) NULL, 
	scores NVARCHAR(max) NULL, 
	athletic_scores NVARCHAR(max) NULL, 
	group_number INTEGER NULL, 
	judge_person_ids NVARCHAR(max) NULL, 
	tie_break_place INTEGER NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	version INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(category_id) REFERENCES categories (id), 
	FOREIGN KEY(match_id) REFERENCES matches (id), 
	FOREIGN KEY(registration_id) REFERENCES registrations (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

CREATE INDEX ix_kata_performances_category_id ON kata_performances (category_id);
CREATE INDEX ix_kata_performances_registration_id ON kata_performances (registration_id);
CREATE TABLE match_events (
	id VARCHAR(36) NOT NULL, 
	match_id INTEGER NOT NULL, 
	type VARCHAR(20) NOT NULL, 
	color VARCHAR(3) NULL, 
	value NUMERIC(8, 2) NULL, 
	target_id VARCHAR(36) NULL, 
	method VARCHAR(30) NULL, 
	reason NVARCHAR(500) NULL, 
	infraction VARCHAR(30) NULL, 
	ladder VARCHAR(2) NULL, 
	device_at DATETIME2 NOT NULL, 
	received_at DATETIME2 NOT NULL, 
	user_id INTEGER NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(match_id) REFERENCES matches (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE INDEX ix_match_events_match ON match_events (match_id, device_at);
CREATE TABLE match_presence (
	id INTEGER NOT NULL IDENTITY, 
	match_id INTEGER NOT NULL, 
	device_id VARCHAR(40) NOT NULL, 
	user_id INTEGER NULL, 
	first_seen DATETIME2 NOT NULL, 
	last_seen DATETIME2 NOT NULL, 
	is_primary BIT NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (match_id, device_id), 
	FOREIGN KEY(match_id) REFERENCES matches (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE INDEX ix_match_presence_last_seen ON match_presence (last_seen);
CREATE INDEX ix_match_presence_match_id ON match_presence (match_id);
CREATE TABLE shadow_comparisons (
	id INTEGER NOT NULL IDENTITY, 
	match_id INTEGER NOT NULL, 
	official_winner_registration_id INTEGER NULL, 
	official_aka_score INTEGER NULL, 
	official_ao_score INTEGER NULL, 
	finding NVARCHAR(1000) NULL, 
	error_source VARCHAR(20) NULL, 
	created_at DATETIME2 NOT NULL, 
	updated_at DATETIME2 NOT NULL, 
	updated_by_id INTEGER NULL, 
	PRIMARY KEY (id), 
	UNIQUE (match_id), 
	FOREIGN KEY(match_id) REFERENCES matches (id), 
	FOREIGN KEY(official_winner_registration_id) REFERENCES registrations (id), 
	FOREIGN KEY(updated_by_id) REFERENCES users (id)
);

ALTER TABLE users ADD FOREIGN KEY(person_id) REFERENCES persons (id);
ALTER TABLE brackets ADD FOREIGN KEY(current_version_id) REFERENCES bracket_versions (id);

COMMIT;
