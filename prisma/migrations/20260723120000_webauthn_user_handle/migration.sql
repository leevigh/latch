-- AlterTable
ALTER TABLE "webauthn_credentials" ADD COLUMN "webauthn_user_handle" TEXT;

-- AlterTable
ALTER TABLE "webauthn_challenges" ADD COLUMN "webauthn_user_handle" TEXT;
