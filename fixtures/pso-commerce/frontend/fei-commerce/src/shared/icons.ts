import type { IconType } from "react-icons";
import { FiBox, FiGrid, FiHome, FiPackage, FiShoppingCart, FiUsers, FiSettings, FiBarChart2, FiFileText } from "react-icons/fi";

/** Names a FEI.pso.ts entry may use as `icon`. Add the icons your microfrontends need. */
export const ICONS: Record<string, IconType> = {
  home: FiHome, users: FiUsers, customers: FiUsers, package: FiPackage, catalog: FiPackage, cart: FiShoppingCart, orders: FiShoppingCart,
  box: FiBox, grid: FiGrid, settings: FiSettings, chart: FiBarChart2, file: FiFileText,
};
export const iconFor = (name: string | undefined): IconType => (name && ICONS[name]) || FiGrid;
