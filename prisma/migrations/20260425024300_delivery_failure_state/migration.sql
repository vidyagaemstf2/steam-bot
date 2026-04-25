ALTER TABLE `pending_deliveries`
    ADD COLUMN `last_attempt_at` DATETIME(3) NULL,
    ADD COLUMN `last_failure_code` VARCHAR(64) NULL,
    ADD COLUMN `last_failure_message` VARCHAR(512) NULL;
