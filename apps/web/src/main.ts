import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import "./life-calendar.css";
import { dialogDirective } from "./directives/dialog";

createApp(App)
  .use(createPinia())
  .directive("dialog", dialogDirective)
  .mount("#app");
