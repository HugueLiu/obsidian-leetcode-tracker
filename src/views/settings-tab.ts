import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type LeetCodeTrackerPlugin from "../main";
import { isEmbeddedLoginAvailable, pickCookiePairs } from "../auth/embedded-login";

export class TrackerSettingTab extends PluginSettingTab {
  private plugin: LeetCodeTrackerPlugin;
  private confirmResetAt = 0;

  constructor(app: App, plugin: LeetCodeTrackerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "LeetCode Tracker" });

    // ---- 登录态 ----
    containerEl.createEl("h3", { text: "力扣登录态" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "自动同步提交记录需要登录态。打开 leetcode.cn 任一页面 → F12 → Network → 任意 graphql 请求 → 复制请求头里的整条 Cookie 粘到下面。只取 LEETCODE_SESSION 和 csrftoken，其余会被忽略。",
    });

    new Setting(containerEl)
      .setName("Cookie")
      .setDesc("形如 LEETCODE_SESSION=xxx; csrftoken=yyy")
      .addTextArea((t) => {
        t.setPlaceholder("LEETCODE_SESSION=...; csrftoken=...");
        t.setValue(this.plugin.data.settings.cookie);
        t.inputEl.rows = 3;
        t.inputEl.addClass("lc-cookie-input");
        t.onChange(async (v) => {
          this.plugin.data.settings.cookie = v.trim();
          await this.plugin.savePluginData();
        });
      });

    const loginSetting = new Setting(containerEl).setName("内嵌登录");

    if (isEmbeddedLoginAvailable()) {
      loginSetting
        .setDesc("在插件里打开力扣登录页，登录成功后自动取走 cookie、验证通过才保存。")
        .addButton((b) =>
          b
            .setButtonText("打开登录窗口")
            .setCta()
            .onClick(async () => {
              b.setDisabled(true);
              await this.plugin.loginWithEmbeddedWindow();
              b.setDisabled(false);
              this.display();
            })
        );
    } else {
      loginSetting.setDesc(
        "当前环境不支持内嵌登录（移动端，或该版本 Obsidian 未暴露 Electron remote）。请用下面的手动方式。"
      );
    }

    new Setting(containerEl)
      .setName("从剪贴板填入")
      .setDesc("复制完整 Cookie 后点这里，自动只挑出 LEETCODE_SESSION 和 csrftoken")
      .addButton((b) =>
        b.setButtonText("读取剪贴板").onClick(async () => {
          try {
            const raw = await navigator.clipboard.readText();
            const picked = pickCookiePairs(raw);
            if (!picked) {
              new Notice("剪贴板里没有 LEETCODE_SESSION，请确认复制的是整条 Cookie", 6000);
              return;
            }
            this.plugin.data.settings.cookie = picked;
            await this.plugin.savePluginData();
            new Notice("已从剪贴板填入，建议点「测试」确认一下");
            this.display();
          } catch (e) {
            new Notice(`读剪贴板失败：${String(e)}`, 6000);
          }
        })
      );

    new Setting(containerEl)
      .setName("测试登录态")
      .setDesc("发一条 userStatus 查询，确认 cookie 有效")
      .addButton((b) =>
        b.setButtonText("测试").onClick(async () => {
          b.setDisabled(true);
          try {
            const account = await this.plugin.client.assertSignedIn();
            this.plugin.authState = "ok";
            this.plugin.applyAccount(account);
            await this.plugin.savePluginData();
            this.plugin.refreshViews();
            new Notice(`登录有效，当前账号：${account.username}`);
            this.display();
          } catch (e) {
            new Notice(this.plugin.describeError(e), 8000);
          } finally {
            b.setDisabled(false);
          }
        })
      );

    // ---- 同步 ----
    containerEl.createEl("h3", { text: "同步" });

    new Setting(containerEl)
      .setName("定时同步间隔")
      .setDesc("单位分钟，0 表示关闭定时同步。只在 Obsidian 运行期间生效。")
      .addText((t) =>
        t.setValue(String(this.plugin.data.settings.syncIntervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isNaN(n) && n >= 0) {
            this.plugin.data.settings.syncIntervalMinutes = n;
            await this.plugin.savePluginData();
            this.plugin.restartTimer();
          }
        })
      );

    new Setting(containerEl)
      .setName("启动时自动同步")
      .setDesc("打开 Obsidian 后同步一次提交记录")
      .addToggle((t) =>
        t.setValue(this.plugin.data.settings.autoSyncOnLoad).onChange(async (v) => {
          this.plugin.data.settings.autoSyncOnLoad = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("显示「仅历史」的题")
      .setDesc("做过、但通过时间早于重置线的题，以 ◐ 灰显。关掉则完全按未刷处理。")
      .addToggle((t) =>
        t.setValue(this.plugin.data.settings.showStale).onChange(async (v) => {
          this.plugin.data.settings.showStale = v;
          await this.plugin.savePluginData();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("显示会员题")
      .setDesc("题库 4498 道里约 790 道需要会员。关掉则不占列表、也不计入进度分母。")
      .addToggle((t) =>
        t.setValue(this.plugin.data.settings.showPaid).onChange(async (v) => {
          this.plugin.data.settings.showPaid = v;
          await this.plugin.savePluginData();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("题库同步")
      .setDesc(`本地 ${this.plugin.problems.size} 道题。力扣题库约 4500 道，首次拉取约 45 页 / 30 秒。`)
      .addButton((b) =>
        b.setButtonText("立即刷新").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.syncProblems();
          b.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName("提交记录同步")
      .setDesc(
        "增量同步：只拉上次之后的新提交，撞到游标就停，几秒完成（单次最多 30 页 / 1200 条）。日常点这个。\n" +
          "全量对齐：按题目逐道查一遍，把被 2000 条窗口截掉的历史补齐。全局提交列表的 offset 硬上限是 " +
          "2000 条（2020 年前的记录拿不到），但带上题目参数单题查没有这个限制 —— 平台网页能显示到 2016 年，" +
          "用的就是这条路。约 15 分钟，按提交 ID 去重，缺多少补多少，中途关掉不会写坏数据。"
      )
      .addButton((b) =>
        b.setButtonText("增量同步").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.syncSubmissions(false);
          b.setDisabled(false);
        })
      )
      .addButton((b) =>
        b.setButtonText("全量对齐").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.syncFullHistory();
          b.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName("导入已有进度")
      .setDesc("从账号一次性导入「做过的题」作为历史底数。只能拿到最后一次提交时间，属近似值。")
      .addButton((b) =>
        b.setButtonText("导入").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.importProgress();
          b.setDisabled(false);
        })
      );

    // ---- 重置 ----
    containerEl.createEl("h3", { text: "重置" });
    const base = this.plugin.data.reset.globalBaseline;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: base
        ? `当前全局重置线：${new Date(base * 1000).toLocaleString()}。早于这条线的通过记录不再计入「已刷」。`
        : "当前没有全局重置线：力扣上做过的题都算已刷。",
    });

    new Setting(containerEl)
      .setName("重置全部")
      .setDesc("把所有题回到「未刷」。不会删除任何记录，只是把判定线抬到现在。点两次生效。")
      .addButton((b) => {
        b.setButtonText("重置全部").setWarning();
        b.onClick(async () => {
          const now = Date.now();
          if (now - this.confirmResetAt > 4000) {
            this.confirmResetAt = now;
            b.setButtonText("再点一次确认");
            window.setTimeout(() => b.setButtonText("重置全部"), 4000);
            return;
          }
          this.confirmResetAt = 0;
          b.setButtonText("重置全部");
          await this.plugin.resetAll();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("撤销全局重置")
      .setDesc("把全局重置线改回 0，所有历史通过记录重新计入。")
      .addButton((b) =>
        b.setButtonText("撤销").onClick(async () => {
          await this.plugin.clearResetAll();
          this.display();
        })
      );

    // ---- 数据 ----
    containerEl.createEl("h3", { text: "本地数据" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `题库：.leetcode/problems.csv（${this.plugin.problems.size} 行）\n` +
        `提交记录：.leetcode/records.csv（${this.plugin.records.count} 行，只追加）\n` +
        `重置线与配置：插件 data.json`,
    });
  }
}
