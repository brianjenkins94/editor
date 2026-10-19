-- The kill switch (OPERATIONS.md, "The kill switch"): one row. `switched_on` says the API answers "Down for maintenance";
-- `reason` and `by` say why and who or what turned it ("user:<id>", "cost guard", "tripwire", "break glass"), `at` when.
-- `noticed` is 0 until a Worker has seen the change and audited it and emailed the owner: a flip made outside the
-- Worker (`npm run maintenance`, through wrangler) is recorded the same way as one made through it.
CREATE TABLE maintenance (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	switched_on INTEGER NOT NULL,
	reason TEXT,
	by TEXT,
	at INTEGER,
	noticed INTEGER NOT NULL DEFAULT 1
);

INSERT INTO maintenance (id, switched_on, noticed) VALUES (1, 0, 1);
