export class PluginManager {
  constructor() {
    this.plugins = [];
  }

  register(plugin) {
    if (!plugin.name || typeof plugin.canHandle !== "function" || typeof plugin.process !== "function") {
      throw new Error("Plugin không đúng chuẩn giao tiếp.");
    }
    this.plugins.push(plugin);
  }

  // Chuyển đổi danh sách raw data thành danh sách dữ liệu chuẩn hóa
  normalizeAll(rawList) {
    const standardizedStreams = [];
    for (const plugin of this.plugins) {
      const matchedItems = rawList.filter(item => plugin.canHandle(item, rawList));
      if (matchedItems.length > 0) {
        const results = plugin.process(matchedItems, rawList);
        standardizedStreams.push(...results);
      }
    }
    return standardizedStreams;
  }
}