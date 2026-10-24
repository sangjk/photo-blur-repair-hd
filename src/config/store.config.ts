/* =============================================================================
 * store.config.ts —— 微软合作伙伴中心「产品标识」单一事实来源
 *
 * 上传 MSIX 到微软应用中心时，包清单（src-tauri/msix/AppxManifest.xml）的
 * Identity 必须与 Partner Center 分配的产品标识完全一致，否则提交校验失败。
 * 本文件与 AppxManifest 的 Identity@Name / Identity@Publisher /
 * PublisherDisplayName 三项必须保持同步（Agent 在 AGENT.md Phase 4 核对）。
 *
 * 换软件 / 换商店产品时：TASK.md 第 5 项 → 本文件 + AppxManifest 同步更新。
 * ========================================================================== */

/** 微软商店产品标识（来源：TASK.md 第 5 项，勿手写其他值） */
export const STORE_IDENTITY = {
  /** Package/Identity/Name —— 与 AppxManifest Identity@Name 一致 */
  packageIdentityName: 'sangkl.14450DCD030AC',
  /** Package/Identity/Publisher —— 与 AppxManifest Identity@Publisher 一致（CN= 开头完整串） */
  publisher: 'CN=3F86E209-E919-4DFD-BBFE-3B881A180019',
  /** Package/Properties/PublisherDisplayName —— 与 AppxManifest PublisherDisplayName 一致 */
  publisherDisplayName: 'sangkl',
  /** Package Family Name（PFN）—— 商店服务 / 通知 / 许可 API 用 */
  packageFamilyName: 'sangkl.14450DCD030AC_fbnffa3ktn7mr',
  /** Package SID —— 商店服务调用时标识包身份 */
  packageSid: 'S-1-15-2-1993567632-217587554-2159602485-2931558434-4038127293-3693591000-3074216147',
  /** MSA 应用 ID —— 微软账号认证（MSAL 等）用 */
  msaAppId: 'efe50107-c5df-45c2-81a8-1110d51c9731',
  /** Store ID —— 商店产品编号 */
  storeId: '9MV4ZDZC8XG7',
} as const

/** 商店详情页（Windows 协议链接，仅在系统内可打开） */
export const STORE_PAGE_URL = `ms-windows://pdp/?productid=${STORE_IDENTITY.storeId}`

/** 商店网页版详情页（浏览器可打开，用于「关于」弹窗等展示） */
export const STORE_WEB_URL = `https://apps.microsoft.com/detail/${STORE_IDENTITY.storeId}`

export default STORE_IDENTITY
