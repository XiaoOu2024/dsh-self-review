# Publishing / 发布

这份文件是给作者自己看的：把插件发到 npm、再收录进社区市场（awesome-dsh-plugin）。

## 0. 发布前检查清单

- [ ] `package.json` 没有 `"private": true`
- [ ] `engines.dsh` 与实测的 dsh 版本一致（当前 `=0.2.1-rc.2`）
- [ ] `version` 已递增（当前 `0.3.0`）
- [ ] `node test.mjs` 与 `node test-client.mjs` 全绿
- [ ] `cordis.patch.yml` 里没有本机绝对路径，`debug: false`
- [ ] 没有把 `self-review.log`、`node_modules`、测试产物打进包（`files` 已限定）
- [ ] `repository` / `homepage` / `bugs` 指向真实仓库（本包暂未填，填上更利于市场展示）

## 1. 建仓库

GitHub 仓库名建议与包名一致（`dsh-self-review`），并：

- 给仓库加 `dsh-plugin` topic；
- 仓库创建满 1 天后才能收录（CI 会查）；
- 把本目录内容推上去（`index.js`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`）。

```sh
git init
git add .
git commit -m "dsh-self-review 0.3.0"
git remote add origin git@github.com:XiaoOu2024/dsh-self-review.git
git push -u origin main
```

## 2. 发布 npm（推荐）

预构建包安装时不需要 `allowBuilds` 构建授权，市场会优先提供它。

```sh
npm publish
```

发布后自测一次真实安装：

```sh
dsh plugin --profile web add dsh-self-review@0.3.0
```

> 包名 `dsh-self-review` 若在 npm 上已被占用，改用带 scope 的名字（如 `@XiaoOu2024/dsh-self-review`）。
> 改包名时**必须同时改** `client.js` 里 `__ModuleLoader__.load({ id: ... })` 的 id，两者必须一致。

## 3. 收录进市场

社区市场（dshmarket、dshmarket.com、awesome-dsh-plugin.com）的条目来自
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库。
给它提一个 PR，只加一个文件 `data/plugins/XiaoOu2024__dsh-self-review.yml`，内容照
[market-entry.yml](market-entry.yml) 抄（`url` 必须与仓库完全一致）。

- 一个 PR 最多 3 条；
- `description.en` 必填，`zh` 可选；
- 描述要与代码一致，别写营销词；
- 不发 npm 的话，可以在 GitHub Release 挂预构建 `.tgz`，用 `tarball:` 字段指向它。

合并后市场与网站自动重建，通常一天内出现。

## 4. 版本限制怎么维护

`engines.dsh` 是唯一的 dsh 版本门槛（`plugin_manager`、启动 preflight、市场兼容性展示都读它）。

```jsonc
"engines": { "dsh": "=0.2.1-rc.2" }   // 只认当前实测版本
```

行为：

- **安装**：不满足时 `plugin_manager` 直接拒绝并给出明确提示；
- **启动**：不满足的 bundle 会被跳过（不影响其他插件启动），插件表现为“消失”；
- **市场**：卡片上显示不兼容。

在别的 dsh 版本上实测过之后，再放宽：

```jsonc
"engines": { "dsh": "^0.2.1-rc.2" }          // 0.2.x 全放行（含 0.2.1 正式版、0.2.2）
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" } // 同上，但排除 0.3.0 的预发布
```

注意：DSH 是 0.x，`^0.2.1` 等价于 `>=0.2.1 <0.3.0`，**不会**放到 0.3。

每次发布新版本时，记得同步更新 README 的「兼容性」一节，并在 PR 里说明改了哪一行。

## 5. 发布后回归

1. 新 profile 里 `dsh plugin --profile web add dsh-self-review@<version>`；
2. 刷新页面，长回答后应出现「自检中」；
3. 故意问一个容易算错的问题，看 `self-review.log`（`debug: true` 时）里是否有 `verdict`；
4. 确认卸载后不再有 `/dsh-self-review/state` 请求。
