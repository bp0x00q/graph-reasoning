CREATE CONSTRAINT run_id IF NOT EXISTS FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT state_id IF NOT EXISTS FOR (n:State) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT branchpoint_id IF NOT EXISTS FOR (n:BranchPoint) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT branch_id IF NOT EXISTS FOR (n:Branch) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT reasoning_node_id IF NOT EXISTS FOR (n:ReasoningNode) REQUIRE n.id IS UNIQUE;
CREATE INDEX run_status IF NOT EXISTS FOR (n:Run) ON (n.status);
CREATE INDEX branch_run_status IF NOT EXISTS FOR (n:Branch) ON (n.runId, n.status);
CREATE INDEX reasoning_node_run_kind IF NOT EXISTS FOR (n:ReasoningNode) ON (n.runId, n.kind);
CREATE INDEX reasoning_node_run_status IF NOT EXISTS FOR (n:ReasoningNode) ON (n.runId, n.status);
