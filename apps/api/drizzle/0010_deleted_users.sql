CREATE TABLE "deleted_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_deleted_at" timestamp with time zone
);
