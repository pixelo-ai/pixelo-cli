import { api, printApiError } from "../lib/api.js";

type Model = {
  id: string;
  name: string;
  displayName?: string;
  type: string;
  calculatedCost?: number;
  baseCost?: number;
  isFreeTierAvailable?: boolean;
};

export async function listModels(flags: { type?: string; json?: boolean; apiUrl?: string }): Promise<void> {
  try {
    const type = flags.type?.toUpperCase();
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    const response = await api<{ data?: Model[] }>(`/api/models${query}`, { apiUrl: flags.apiUrl, auth: false });
    const models = Array.isArray(response) ? (response as Model[]) : response.data ?? [];
    const list = models.filter((model) => !type || model.type === type);

    if (flags.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    for (const model of list) {
      const cost = model.calculatedCost || model.baseCost;
      console.log(
        `${model.id.padEnd(44)} ${model.type.padEnd(7)} ${cost ? `${cost} credits` : ""}`,
      );
    }
    if (list.length === 0) console.log("No models found.");
  } catch (error) {
    printApiError(error);
  }
}
