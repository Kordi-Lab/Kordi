-- Vote options on a plan card. Each option is {id, label, startAt?, endAt?,
-- location?, votes: [account ids]}; a card in the polling state collects one
-- vote per participant across its options.
ALTER TABLE cloud_plan_cards ADD COLUMN options JSONB NOT NULL DEFAULT '[]';
