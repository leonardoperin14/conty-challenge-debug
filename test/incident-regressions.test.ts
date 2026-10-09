import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

function setup() {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return { app: createApp(db), db };
}

type TestContext = ReturnType<typeof setup>;
type MissionResponse = {
  mission: { status: string };
  ledger: Array<{ id: string; idempotency_key: string; amount_brl: number }>;
  payout: { id: string; provider_status: string | null; status: string } | null;
};
type ApprovalResponse = {
  mission_id: string;
  status: string;
  ledger: { id: string; idempotency_key: string; amount_brl: number };
  payout: { id: string };
};

async function postJson(context: TestContext, path: string, body: unknown) {
  return context.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function mission(context: TestContext, id: string): Promise<MissionResponse> {
  const response = await context.app.request(`/missions/${id}`);
  return (await response.json()) as MissionResponse;
}

describe("regressões do incidente de repasses", () => {
  let context: TestContext;

  beforeEach(() => {
    context = setup();
  });

  afterEach(() => {
    context.db.close();
  });

  it.each([
    {
      name: "aceita o último milissegundo do prazo em São Paulo",
      approvedAt: "2026-03-13T02:59:59.999Z",
      expectedStatus: 201,
      expectedMissionStatus: "approved",
      expectedLedgerCount: 1,
      expectedPayoutCount: 1,
    },
    {
      name: "recusa a meia-noite seguinte ao prazo em São Paulo",
      approvedAt: "2026-03-13T03:00:00.000Z",
      expectedStatus: 409,
      expectedMissionStatus: "open",
      expectedLedgerCount: 0,
      expectedPayoutCount: 0,
    },
    {
      name: "interpreta um timestamp com deslocamento explícito",
      approvedAt: "2026-03-12T23:59:59.999-03:00",
      expectedStatus: 201,
      expectedMissionStatus: "approved",
      expectedLedgerCount: 1,
      expectedPayoutCount: 1,
    },
  ])("$name", async ({ approvedAt, expectedStatus, expectedMissionStatus, expectedLedgerCount, expectedPayoutCount }) => {
    const response = await postJson(context, "/approvals", {
      mission_id: "msn_1842",
      approved_at: approvedAt,
      idempotency_key: "pay_deadline",
    });

    expect(response.status).toBe(expectedStatus);
    const result = await mission(context, "msn_1842");
    expect(result.mission.status).toBe(expectedMissionStatus);
    expect(result.ledger).toHaveLength(expectedLedgerCount);
    const payouts = context.db
      .prepare("SELECT COUNT(*) AS count FROM payouts WHERE mission_id = ?")
      .get("msn_1842") as { count: number };
    expect(payouts.count).toBe(expectedPayoutCount);
  });

  it("converte os 8000 centavos da missão em R$ 80,00", async () => {
    const response = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_money",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as ApprovalResponse;
    expect(body.ledger.amount_brl).toBe(80);
    const result = await mission(context, "msn_2044");
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0].amount_brl).toBe(80);
  });

  it.each([
    { name: "espaços", key: "   " },
    { name: "tabulação", key: "\t\t" },
    { name: "U+200B", key: "\u200B" },
    { name: "espaços, tabulação e U+200B", key: " \t\u200B \t" },
  ])("rejeita chave canônica vazia formada por $name sem gravar dados", async ({ key }) => {
    const response = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: key,
    });

    expect(response.status).toBe(400);
    const result = await mission(context, "msn_2044");
    expect(result.mission.status).toBe("open");
    expect(result.ledger).toHaveLength(0);
    const payouts = context.db
      .prepare("SELECT COUNT(*) AS count FROM payouts WHERE mission_id = ?")
      .get("msn_2044") as { count: number };
    expect(payouts.count).toBe(0);
  });

  it.each([
    { name: "repetida", retryKey: "pay_7c1" },
    { name: "com espaço final", retryKey: "pay_7c1 " },
    { name: "com espaços nas extremidades", retryKey: " pay_7c1 " },
    { name: "em maiúsculas", retryKey: "PAY_7C1" },
    { name: "com U+200B no final", retryKey: "pay_7c1\u200B" },
  ])("não duplica crédito em uma repetição $name", async ({ retryKey }) => {
    const first = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as ApprovalResponse;

    const retry = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: retryKey,
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as ApprovalResponse;

    expect(retryBody.ledger.id).toBe(firstBody.ledger.id);
    expect(retryBody.payout.id).toBe(firstBody.payout.id);
    expect(retryBody.ledger.idempotency_key).toBe("pay_7c1");

    const result = await mission(context, "msn_2044");
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0].id).toBe(firstBody.ledger.id);
    const payouts = context.db
      .prepare("SELECT COUNT(*) AS count FROM payouts WHERE mission_id = ?")
      .get("msn_2044") as { count: number };
    expect(payouts.count).toBe(1);
  });

  it("reutiliza o crédito quando a missão aprovada recebe uma chave diferente", async () => {
    const first = await postJson(context, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_first_key",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as ApprovalResponse;

    const retry = await postJson(context, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_different_key",
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as ApprovalResponse;

    expect(retryBody.status).toBe("approved");
    expect(retryBody.ledger.id).toBe(firstBody.ledger.id);
    expect(retryBody.ledger.idempotency_key).toBe("pay_first_key");
    expect(retryBody.ledger.amount_brl).toBe(150);
    expect(retryBody.payout.id).toBe(firstBody.payout.id);

    const result = await mission(context, "msn_1900");
    expect(result.mission.status).toBe("approved");
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0].id).toBe(firstBody.ledger.id);
    expect(result.ledger[0].amount_brl).toBe(150);
    expect(result.ledger.reduce((total, ledger) => total + ledger.amount_brl, 0)).toBe(150);
    expect(result.payout?.id).toBe(firstBody.payout.id);
  });

  it("rejeita colisão global antes do fallback para o crédito de uma missão aprovada", async () => {
    const sourceApproval = await postJson(context, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_shared_key",
    });
    expect(sourceApproval.status).toBe(201);
    const sourceBody = (await sourceApproval.json()) as ApprovalResponse;

    const targetApproval = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_target_key",
    });
    expect(targetApproval.status).toBe(201);
    const targetBody = (await targetApproval.json()) as ApprovalResponse;

    const collision = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_shared_key",
    });
    expect(collision.status).toBe(409);
    const collisionBody = (await collision.json()) as Record<string, unknown>;
    expect(Object.keys(collisionBody)).toEqual(["error"]);
    expect(collisionBody).not.toHaveProperty("ledger");
    expect(collisionBody).not.toHaveProperty("payout");
    expect(JSON.stringify(collisionBody)).not.toContain(sourceBody.ledger.id);

    const sourceResult = await mission(context, "msn_1900");
    expect(sourceResult.mission.status).toBe("approved");
    expect(sourceResult.ledger).toHaveLength(1);
    expect(sourceResult.ledger[0].id).toBe(sourceBody.ledger.id);
    expect(sourceResult.ledger[0].amount_brl).toBe(150);
    expect(sourceResult.payout?.id).toBe(sourceBody.payout.id);
    expect(sourceResult.payout?.provider_status).toBeNull();
    expect(sourceResult.payout?.status).toBe("pending");

    const targetResult = await mission(context, "msn_2044");
    expect(targetResult.mission.status).toBe("approved");
    expect(targetResult.ledger).toHaveLength(1);
    expect(targetResult.ledger[0].id).toBe(targetBody.ledger.id);
    expect(targetResult.ledger[0].amount_brl).toBe(80);
    expect(targetResult.payout?.id).toBe(targetBody.payout.id);
    expect(targetResult.payout?.provider_status).toBeNull();
    expect(targetResult.payout?.status).toBe("pending");
  });

  it("rejeita chave global de outra missão sem alterar o alvo ainda aberto", async () => {
    const sourceApproval = await postJson(context, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_open_collision",
    });
    expect(sourceApproval.status).toBe(201);
    const sourceBody = (await sourceApproval.json()) as ApprovalResponse;

    const collision = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_open_collision",
    });
    expect(collision.status).toBe(409);
    const collisionBody = (await collision.json()) as Record<string, unknown>;
    expect(Object.keys(collisionBody)).toEqual(["error"]);
    expect(collisionBody).not.toHaveProperty("ledger");
    expect(collisionBody).not.toHaveProperty("payout");
    expect(JSON.stringify(collisionBody)).not.toContain(sourceBody.ledger.id);

    const sourceResult = await mission(context, "msn_1900");
    expect(sourceResult.mission.status).toBe("approved");
    expect(sourceResult.ledger).toHaveLength(1);
    expect(sourceResult.ledger[0].id).toBe(sourceBody.ledger.id);
    expect(sourceResult.ledger[0].amount_brl).toBe(150);
    expect(sourceResult.payout?.id).toBe(sourceBody.payout.id);
    expect(sourceResult.payout?.status).toBe("pending");

    const targetResult = await mission(context, "msn_2044");
    expect(targetResult.mission.status).toBe("open");
    expect(targetResult.ledger).toHaveLength(0);
    expect(targetResult.payout).toBeNull();
  });

  it.each([
    { providerStatus: "PENDING", expectedStatus: "pending" },
    { providerStatus: "RECEIVED", expectedStatus: "paid" },
    { providerStatus: "CONFIRMED", expectedStatus: "paid" },
    { providerStatus: "FAILED", expectedStatus: "failed" },
  ])("mapeia $providerStatus para $expectedStatus", async ({ providerStatus, expectedStatus }) => {
    const approval = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_provider",
    });
    expect(approval.status).toBe(201);
    const approvalBody = (await approval.json()) as ApprovalResponse;

    const callback = await postJson(context, `/payouts/${approvalBody.payout.id}/provider`, {
      provider_status: providerStatus,
    });
    expect(callback.status).toBe(200);
    const callbackBody = (await callback.json()) as { status: string };
    expect(callbackBody.status).toBe(expectedStatus);

    const result = await mission(context, "msn_2044");
    expect(result.payout?.provider_status).toBe(providerStatus);
    expect(result.payout?.status).toBe(expectedStatus);
  });

  it("rejeita status desconhecido sem alterar o repasse", async () => {
    const approval = await postJson(context, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_provider_unknown",
    });
    expect(approval.status).toBe(201);
    const approvalBody = (await approval.json()) as ApprovalResponse;

    const callback = await postJson(context, `/payouts/${approvalBody.payout.id}/provider`, {
      provider_status: "INVALID",
    });
    expect(callback.status).toBe(400);

    const result = await mission(context, "msn_2044");
    expect(result.payout?.provider_status).toBeNull();
    expect(result.payout?.status).toBe("pending");
  });
});
