export default {
  fetch() {
    return new Response("ZeroErrors has moved to api.zeroapps.dev/errors/v1", {
      status: 410,
    });
  },
};
