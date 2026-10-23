import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import "./life-calendar.css";
import "./paper-theme.css";
import { initializeColorTheme } from "./theme";
import { dialogDirective } from "./directives/dialog";

initializeColorTheme();

createApp(App)
  .use(createPinia())
  .directive("dialog", dialogDirective)
  .mount("#app");
