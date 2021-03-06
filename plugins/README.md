# ZoneMTA plugins

This is the folder for plugins

Plugin files should expose a property called 'title' to identify themselves

Plugins should expose an `init` method. This method should register to all the required hooks

```
module.exports.init = function(app, next){
    // handle plugin initialization
    done();
};
```

Plugins are loaded in the order defined in `config.plugins` object

## Available hooks

Hookes can be set up with the following command

    app.addHook(name, handler)

Where

  * **name** is the event to hook into
  * **handler** is the hook function. Actual arguments vary by the hook but the last argument is always a return function that needs to be called before the message can be further processed

Possible hook names are the following:

- **'feeder:mail_from'** with arguments `address`, `session`, called when MAIL FROM command is issued by the client
- **'feeder:rcpt_to'** with arguments `address`, `session`, called when RCPT TO command is issued by the client
- **'feeder:auth'** with arguments `auth`, `session`, called when AUTH command is issued by the client
- **'message:headers'** with arguments `envelope`, `headers`, called when rfc822 headers are found from the incoming message

## Using Message Rewriter

You can modify individual message nodes by setting up a message rewriter hook

    app.addRewriteHook(filter, handler)

Where

  * **filter** is a function that is called for every found mime node. If the function returns true, than this node will be processed, otherwise it is skipped. The function gets two arguments: `envelope` and `node`
  * **handler** is a function that provides the envelope data. The function gets two arguments: `envelope` and `data` where `data` is an object with the following properties: `node`, `decoder`, `encoder`.

**NB** once you have written something to the `encoder` stream, you can't modify node headers anymore. If you modify headers after sending data to the encoder you might run into race conditions where you can not know if the updated header data was actually used or not.

See example plugin [here](example-plugin.js)
